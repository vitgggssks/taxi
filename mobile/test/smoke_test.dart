import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/api.dart';
import 'package:rukh_mobile/main.dart' show kDefaultBaseUrl;
import 'package:rukh_mobile/core/format.dart';
import 'package:rukh_mobile/core/models.dart';
import 'package:rukh_mobile/theme.dart';

/// Компіляційний та логічний smoke-тест: імпорт theme.dart тягне material_ui,
/// моделі перевіряють розбір реальних відповідей API.
void main() {
  test('гроші форматуються в гривнях з копійками', () {
    expect(money(0), '0 ₴');
    expect(money(8609), '86.09 ₴');
    expect(money(20000), '200 ₴');
    expect(money(-5000), '−50 ₴');
  });

  test('статуси мають людські підписи', () {
    expect(statusLabel('searching'), 'Пошук водія');
    expect(statusLabel('in_progress'), 'У дорозі');
    expect(statusLabel('completed'), 'Завершено');
    expect(paymentLabel('apple_pay'), 'Apple Pay');
    expect(serviceLabel('delivery'), 'Доставка');
  });

  test('Order розбирає проєкцію замовлення з сервера', () {
    final order = Order.fromJson({
      'id': 'ord_1',
      'number': '261119-6551',
      'status': 'assigned',
      'service_kind': 'ride',
      'payment_method': 'cash',
      'payment_status': 'pending',
      'quoted_price_cents': 8609,
      'final_price_cents': null,
      'distance_m': 2210,
      'duration_s': 420,
      'created_at': '2026-11-19 14:41:00',
      'points': [
        {'seq': 0, 'kind': 'pickup', 'address': 'Хрещатик, 1', 'lat': 50.45, 'lng': 30.52},
        {'seq': 1, 'kind': 'dropoff', 'address': 'ТРЦ Gulliver', 'lat': 50.43, 'lng': 30.52},
      ],
      'driver': {'id': 'usr_d', 'name': 'Олег', 'phone': '+380671000102', 'rating': 4.87},
      'vehicle': {'make': 'Toyota', 'model': 'Camry', 'plate': 'AA 1234 BB'},
    });
    expect(order.isActive, isTrue);
    expect(order.priceCents, 8609);
    expect(order.paymentStatus, 'pending');
    expect(order.pickupAddress, 'Хрещатик, 1');
    expect(order.dropoffAddress, 'ТРЦ Gulliver');
    expect(order.driver!.rating, closeTo(4.87, 1e-9));
    expect(order.vehicle!.title, 'Toyota Camry');
  });

  test('Quote розбирає розбивку ціни та множники', () {
    final quote = Quote.fromJson({
      'classId': 'cls_std',
      'classCode': 'standard',
      'className': 'Стандарт',
      'currency': 'UAH',
      'distanceM': 2210,
      'durationS': 420,
      'pickupEtaS': 240,
      'fareCents': 10500,
      'totalCents': 9450,
      'discountCents': 1050,
      'plusMinusCents': 0,
      'commissionPct': 15,
      'breakdown': {'nightMultiplier': 1.2, 'surgeMultiplier': 1.0},
      'lines': [
        {'code': 'child_seat', 'label': 'Дитяче крісло', 'amountCents': 5000},
      ],
    });
    expect(quote.isNight, isTrue);
    expect(quote.surge, 1.0);
    expect(quote.totalCents, 9450);
    expect(quote.lines.single['label'], 'Дитяче крісло');
  });

  test('клієнт API формує URL вебсокета з токеном', () {
    final api = ApiClient(baseUrl: 'http://10.0.2.2:3000/');
    final ws = api.wsUri('tok123');
    expect(ws.toString(), 'ws://10.0.2.2:3000/ws?token=tok123');
    api.close();
  });

  test('застосунок має адресу API за замовчуванням', () {
    expect(kDefaultBaseUrl, contains('://'));
  });

  test('кольори статусів визначені', () {
    expect(statusColor('completed'), RukhTheme.accent);
    expect(statusColor('canceled'), RukhTheme.danger);
  });
}
