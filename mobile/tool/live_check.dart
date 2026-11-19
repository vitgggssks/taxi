/// Жива перевірка data-шару застосунку проти реального API.
///
/// Використовує ті самі `ApiClient`, `Realtime` і моделі, що й Android-застосунок,
/// тому перевіряє не «щось схоже», а саме клієнтський код збірки.
///
///   dart run tool/live_check.dart [baseUrl]
///
/// Потрібен запущений сервер (`cd server && npx tsx src/index.ts`).
library;

import 'dart:async';

import 'package:rukh_mobile/core/api.dart';
import 'package:rukh_mobile/core/format.dart';
import 'package:rukh_mobile/core/models.dart';
import 'package:rukh_mobile/core/realtime.dart';

/// Кандидати-водії з сіду. Оффер отримують 3 найближчі, тому перебираємо,
/// доки не знайдемо того, кому диспетчер справді надіслав пропозицію.
const _driverPhones = [
  '+380671000101', '+380671000102', '+380671000103', '+380671000104',
  '+380671000105', '+380671000106', '+380671000107', '+380671000108',
];

var _failures = 0;

void check(String name, bool ok, [String extra = '']) {
  print('${ok ? '✓' : '✗'} $name${extra.isEmpty ? '' : ' — $extra'}');
  if (!ok) _failures++;
}

Future<Map<String, dynamic>> login(ApiClient api, {String? role, String? phone}) async {
  final res = await api.post('/api/auth/demo-login', {
    if (role != null) 'role': role,
    if (phone != null) 'phone': phone,
  });
  return asMap(res);
}

Future<void> main(List<String> args) async {
  final baseUrl = args.isNotEmpty ? args.first : 'http://127.0.0.1:3000';
  final api = ApiClient(baseUrl: baseUrl);
  final driverApi = ApiClient(baseUrl: baseUrl);

  try {
    final health = asMap(await api.get('/api/health'));
    check('health', health['ok'] == true, 'service=${health['service']}');

    // --- пасажир ---
    final session = await login(api, role: 'passenger');
    api.token = '${session['token']}';
    final user = asMap(session['user']);
    check('демо-вхід пасажира', api.token!.isNotEmpty, '${user['phone']}');

    final me = asMap(await api.get('/api/me'));
    check('GET /api/me', '${me['id']}' == '${user['id']}');

    final cities = asMapList(asMap(await api.get('/api/cities'))['items']);
    check('міста', cities.isNotEmpty, '${cities.length} шт.');
    final city = City.fromJson(cities.first);

    final catalog = asMap(await api.get('/api/catalog', {'cityId': city.id, 'classKind': 'ride'}));
    final classes = asMapList(catalog['classes']).map(CarClass.fromJson).toList();
    check('каталог класів', classes.isNotEmpty, classes.map((c) => c.name).join(', '));

    final found = asMapList(asMap(await api.get('/api/geo/search', {'cityId': city.id, 'q': 'Хрещатик'}))['items']);
    check('пошук адреси (кирилиця)', found.isNotEmpty, '${found.length} результатів');
    final pickup = GeoAddress.fromJson(found.first);

    final found2 = asMapList(asMap(await api.get('/api/geo/search', {'cityId': city.id, 'q': 'Gulliver'}))['items']);
    check('пошук адреси №2', found2.isNotEmpty);
    final dropoff = GeoAddress.fromJson(found2.first);

    final quoteRes = asMap(await api.post('/api/orders/quote', {
      'cityId': city.id,
      'points': [pickup.toPointJson(), dropoff.toPointJson()],
      'serviceKind': 'ride',
    }));
    final quotes = asMapList(quoteRes['quotes']).map(Quote.fromJson).toList();
    check('ціна по всіх класах', quotes.length == classes.length,
        quotes.map((q) => '${q.className} ${money(q.totalCents)}').join(' · '));
    check('ціна > 0', quotes.every((q) => q.totalCents > 0));

    // --- замовлення ---
    final created = asMap(await api.post('/api/orders', {
      'cityId': city.id,
      'classId': quotes.first.classId,
      'points': [pickup.toPointJson(), dropoff.toPointJson()],
      'serviceKind': 'ride',
      'paymentMethod': 'cash',
      'comment': 'live_check',
    }));
    final order = Order.fromJson(asMap(created['order']));
    check('створення замовлення', order.id.isNotEmpty, '№${order.number} ${money(order.priceCents)} / ${order.status}');
    check('маршрут у замовленні', order.points.length == 2 && order.pickupAddress.isNotEmpty);

    // --- realtime: чекаємо подію по замовленню ---
    final events = <String>[];
    final rt = Realtime(api: api, onEvent: (event, payload) => events.add(event));
    await rt.connect();
    rt.subscribe('order:${order.id}');

    // --- водій: пропозиція → прийняття → статус ---
    Map<String, dynamic>? liveOffer;
    var driverWithOffer = '';
    for (final phone in _driverPhones) {
      final driverSession = await login(driverApi, phone: phone);
      driverApi.token = '${driverSession['token']}';
      final offers = asMapList(asMap(await driverApi.get('/api/driver/offers'))['items']);
      final match = offers.where((o) => '${asMap(o['order'])['id']}' == order.id).toList();
      if (match.isNotEmpty) {
        liveOffer = match.first;
        driverWithOffer = phone;
        break;
      }
    }
    check('водій бачить пропозицію', liveOffer != null, 'оффер у $driverWithOffer');

    if (liveOffer != null) {
      final offer = Offer.fromJson(liveOffer);
      check('дані пропозиції', offer.priceCents > 0 && offer.secondsLeft > 0,
          'таймер ${offer.secondsLeft}с, подача ${distanceText(offer.distanceToPickupM)}');
      await driverApi.post('/api/driver/offers/${offer.id}/accept');
      final afterAccept = Order.fromJson(asMap(asMap(await api.get('/api/orders/${order.id}'))['order']));
      check('прийняття пропозиції', afterAccept.status == 'assigned');
      check('водій у замовленні', afterAccept.driver != null,
          '${afterAccept.driver?.name} ${afterAccept.vehicle?.plate ?? ''}');

      final arriving = Order.fromJson(asMap(asMap(
              await driverApi.post('/api/driver/orders/${order.id}/status', {'status': 'driver_arriving'}))['order']));
      check('статус → driver_arriving', arriving.status == 'driver_arriving');

      await Future<void>.delayed(const Duration(milliseconds: 600));
      check('realtime події надійшли', events.isNotEmpty, events.take(4).join(', '));

      final canceled = Order.fromJson(asMap(asMap(
          await api.post('/api/orders/${order.id}/cancel', {'reason': 'live_check'}))['order']));
      check('скасування пасажиром', canceled.status == 'canceled');
    }

    rt.dispose();

    // --- гаманець / історія ---
    final wallet = asMap(await api.get('/api/wallet'));
    check('гаманець', wallet['balanceCents'] != null,
        'баланс ${money((wallet['balanceCents'] as num?)?.toInt() ?? 0)}, бонуси ${money((wallet['bonusCents'] as num?)?.toInt() ?? 0)}');
    final history = asMapList(asMap(await api.get('/api/orders', {'limit': '5'}))['items']);
    check('історія замовлень', history.isNotEmpty, '${history.length} останніх');

    print('');
    if (_failures == 0) {
      print('УСІ ПЕРЕВІРКИ ПРОЙДЕНО');
    } else {
      print('ПРОВАЛЕНО ПЕРЕВІРОК: $_failures');
    }
  } on ApiException catch (e) {
    print('✗ API ${e.status} ${e.code}: ${e.message}');
    _failures++;
  } finally {
    api.close();
    driverApi.close();
  }
}
