import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/realtime.dart';
import '../core/session.dart';
import '../theme.dart';
import '../widgets/osm_map.dart';
import 'shell.dart';

/// Робочий екран водія: онлайн/офлайн, вхідні пропозиції з таймером,
/// просування статусів активного замовлення, заробіток.
class DriverScreen extends StatefulWidget {
  const DriverScreen({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  State<DriverScreen> createState() => _DriverScreenState();
}

class _DriverScreenState extends State<DriverScreen> {
  bool _loading = true;
  String? _error;
  DriverProfile? _profile;
  List<Order> _activeOrders = [];
  List<Offer> _offers = [];
  Map<String, dynamic> _earnings = <String, dynamic>{};
  bool _busy = false;

  Realtime? _realtime;
  Timer? _ticker;
  final Map<String, int> _secondsLeft = <String, int>{};

  @override
  void initState() {
    super.initState();
    _load();
    _realtime = Realtime(
      api: widget.api,
      onEvent: (event, payload) {
        if (event == 'offer.new' || event == 'order.updated') _load(silent: true);
      },
    )..connect();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_secondsLeft.isEmpty) return;
      setState(() {
        for (final id in _secondsLeft.keys.toList()) {
          _secondsLeft[id] = (_secondsLeft[id] ?? 0) - 1;
        }
      });
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _realtime?.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final results = await Future.wait([
        widget.api.get('/api/driver/me'),
        widget.api.get('/api/driver/offers'),
        widget.api.get('/api/driver/earnings'),
      ]);
      final me = results[0] is Map ? Map<String, dynamic>.from(results[0] as Map) : <String, dynamic>{};
      final offersRes = results[1] is Map ? Map<String, dynamic>.from(results[1] as Map) : <String, dynamic>{};
      final earnings = results[2] is Map ? Map<String, dynamic>.from(results[2] as Map) : <String, dynamic>{};
      final profile = DriverProfile.fromJson(asMap(me['profile']));
      final orders = asMapList(me['activeOrders']).map(Order.fromJson).toList();
      final offers = asMapList(offersRes['items']).map(Offer.fromJson).toList();
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _activeOrders = orders;
        _offers = offers;
        _earnings = earnings;
        _secondsLeft.clear();
        for (final offer in offers) {
          _secondsLeft[offer.id] = offer.secondsLeft;
        }
      });
    } on ApiException catch (e) {
      if (mounted && !silent) setState(() => _error = e.message);
    } finally {
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  Future<void> _toggleOnline() async {
    final online = _profile?.online ?? false;
    setState(() => _busy = true);
    try {
      await widget.api.post(online ? '/api/driver/offline' : '/api/driver/online');
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept(Offer offer) async {
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/driver/offers/${offer.id}/accept');
      await _load(silent: true);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Замовлення прийнято')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
      await _load(silent: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decline(Offer offer) async {
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/driver/offers/${offer.id}/decline');
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _advance(Order order) async {
    final next = switch (order.status) {
      'assigned' => 'driver_arriving',
      'driver_arriving' => 'waiting',
      'waiting' => 'in_progress',
      'in_progress' => 'completed',
      _ => null,
    };
    if (next == null) return;
    if (next == 'completed') {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Завершити поїздку?'),
          content: Text('До сплати: ${money(order.priceCents)} (${paymentLabel(order.paymentMethod)})'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Ще ні')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Завершити')),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/driver/orders/${order.id}/status', {'status': next});
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
      await _load(silent: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deliveryCode(Order order) async {
    final controller = TextEditingController();
    final step = order.status == 'in_progress' ? 'dropoff' : 'pickup';
    final code = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(step == 'pickup' ? 'Код відправника' : 'Код отримувача'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          autofocus: true,
          decoration: const InputDecoration(labelText: '4 цифри'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('Підтвердити')),
        ],
      ),
    );
    if (code == null || code.isEmpty) return;
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/orders/${order.id}/delivery/$step', {'code': code});
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendLocation() async {
    // У проді тут GPS з геолокації; для збірки без дозволів беремо точку подачі
    // активного замовлення, щоб диспетчер бачив водія на мапі.
    final order = _activeOrders.isEmpty ? null : _activeOrders.first;
    if (order == null || order.points.isEmpty) {
      if (mounted) showError(context, 'Немає активної точки для передачі координат');
      return;
    }
    try {
      await widget.api.post('/api/driver/location', {
        'lat': order.points.first.lat,
        'lng': order.points.first.lng,
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Локацію передано диспетчеру')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final profile = _profile;
    return Scaffold(
      appBar: RukhAppBar(
        title: 'Робота',
        subtitle: profile == null
            ? 'Водій'
            : '${profile.ordersCompleted} поїздок · ${profile.rating.toStringAsFixed(2)}★',
        actions: [
          IconButton(onPressed: _sendLocation, icon: const Icon(Icons.my_location), tooltip: 'Передати локацію'),
          IconButton(onPressed: () => _load(), icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
                children: [
                  if (_error != null) ...[ErrorBox(message: _error!), const SizedBox(height: 12)],
                  if (profile != null) _statusCard(profile),
                  const SizedBox(height: 12),
                  if (_activeOrders.isNotEmpty || _offers.isNotEmpty) ...[
                    _workMap(),
                    const SizedBox(height: 12),
                  ],
                  if (_offers.isNotEmpty) ...[
                    ..._offers.map((offer) => Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: _offerCard(offer),
                        )),
                  ],
                  if (_activeOrders.isNotEmpty) ...[
                    ..._activeOrders.map((order) => Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: _activeCard(order),
                        )),
                  ],
                  if (_offers.isEmpty && _activeOrders.isEmpty) _idleCard(profile),
                  const SizedBox(height: 12),
                  _earningsCard(),
                ],
              ),
            ),
    );
  }

  Widget _workMap() {
    final order = _activeOrders.isNotEmpty
        ? _activeOrders.first
        : (_offers.isNotEmpty ? _offers.first.order : null);
    if (order == null || order.points.isEmpty) return const SizedBox.shrink();
    final points = order.points.map((p) => MapPoint(p.lat, p.lng)).toList();
    final focus = MapFocus.fit(points, viewport: const Size(340, 200));
    return SectionCard(
      title: _offers.isEmpty ? 'Ваш маршрут' : 'Замовлення поруч',
      padding: const EdgeInsets.fromLTRB(10, 16, 10, 10),
      child: OsmMap(
        center: focus.center,
        zoom: focus.zoom,
        markers: [
          MapPins.pickupPin(points.first, label: 'Клієнт'),
          if (points.length > 1) MapPins.dropoffPin(points.last, label: 'Фініш'),
          for (var i = 1; i < points.length - 1; i++) MapPins.stopPin(points[i]),
        ],
        route: points,
        height: 200,
      ),
    );
  }

  Widget _statusCard(DriverProfile profile) {
    final verified = profile.status == 'verified';
    return SectionCard(
      child: Column(
        children: [
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: profile.online ? RukhTheme.accent : RukhTheme.muted,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                !verified
                    ? 'Документи на перевірці (${profile.status})'
                    : profile.workStatus == 'busy'
                        ? 'Виконуєте замовлення'
                        : profile.online
                            ? 'На лінії — отримуєте пропозиції'
                            : 'Офлайн',
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              Switch(
                value: profile.online,
                activeThumbColor: RukhTheme.ink,
                activeTrackColor: RukhTheme.accent,
                onChanged: verified && !_busy ? (_) => _toggleOnline() : null,
              ),
            ],
          ),
          const Divider(height: 22),
          Row(
            children: [
              _metric('${profile.rating.toStringAsFixed(2)}', 'рейтинг'),
              _metric('${(profile.acceptRate * 100).round()}%', 'прийняття'),
              _metric(money(profile.balanceCents), 'баланс'),
              _metric('${profile.commissionPct.toStringAsFixed(0)}%', 'комісія'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _metric(String value, String label) {
    return Expanded(
      child: Column(
        children: [
          Text(value, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(color: RukhTheme.muted, fontSize: 10)),
        ],
      ),
    );
  }

  Widget _offerCard(Offer offer) {
    final left = _secondsLeft[offer.id] ?? 0;
    final order = offer.order;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: RukhTheme.accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: RukhTheme.accent.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.notifications_active, color: RukhTheme.accent, size: 18),
              const SizedBox(width: 8),
              Text('Нове замовлення · раунд ${offer.round}',
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              const Spacer(),
              Text(
                countdown(left),
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: left <= 5 ? RukhTheme.danger : RukhTheme.accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(money(offer.priceCents), style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text(
            'подача ${distanceText(offer.distanceToPickupM)} · ~${(offer.etaToPickupS / 60).ceil()} хв · '
            '${paymentLabel(offer.paymentMethod)}',
            style: const TextStyle(color: RukhTheme.muted, fontSize: 12),
          ),
          const SizedBox(height: 10),
          _routeLine(Icons.trip_origin, order.pickupAddress, RukhTheme.accent),
          const SizedBox(height: 4),
          _routeLine(Icons.place, order.dropoffAddress, const Color(0xFFB47BFF)),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => _decline(offer),
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  child: const Text('Відхилити'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: FilledButton(
                  onPressed: _busy ? null : () => _accept(offer),
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  child: const Text('Прийняти'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _routeLine(IconData icon, String text, Color color) {
    return Row(
      children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis)),
      ],
    );
  }

  Widget _activeCard(Order order) {
    final nextLabel = switch (order.status) {
      'assigned' => 'Я в дорозі до клієнта',
      'driver_arriving' => 'Я на місці',
      'waiting' => 'Почати поїздку',
      'in_progress' => 'Завершити поїздку',
      _ => null,
    };
    final isDelivery = order.serviceKind == 'delivery';
    return SectionCard(
      title: 'Активне замовлення №${order.number}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              StatusChip(status: order.status),
              const Spacer(),
              Text(money(order.priceCents), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            ],
          ),
          const SizedBox(height: 10),
          _routeLine(Icons.trip_origin, order.pickupAddress, RukhTheme.accent),
          const SizedBox(height: 4),
          _routeLine(Icons.place, order.dropoffAddress, const Color(0xFFB47BFF)),
          if (order.comment != null && order.comment!.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Коментар: ${order.comment}', style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
          ],
          const SizedBox(height: 14),
          if (isDelivery)
            OutlinedButton.icon(
              onPressed: _busy ? null : () => _deliveryCode(order),
              icon: const Icon(Icons.pin_outlined),
              label: Text(order.status == 'in_progress' ? 'Підтвердити вручення (код)' : 'Підтвердити отримання (код)'),
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            ),
          if (nextLabel != null) ...[
            if (isDelivery) const SizedBox(height: 8),
            FilledButton(
              onPressed: _busy ? null : () => _advance(order),
              child: Text(nextLabel),
            ),
          ],
        ],
      ),
    );
  }

  Widget _idleCard(DriverProfile? profile) {
    final online = profile?.online ?? false;
    return SectionCard(
      child: Column(
        children: [
          Icon(online ? Icons.radar : Icons.bedtime_outlined,
              size: 42, color: online ? RukhTheme.accent : RukhTheme.muted),
          const SizedBox(height: 12),
          Text(
            online ? 'Очікуємо замовлення поруч…' : 'Ви офлайн',
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            online
                ? 'Пропозиції надходять з урахуванням вашого радіуса та класу авто.'
                : 'Увімкніть «На лінії», щоб почати приймати замовлення.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: RukhTheme.muted, fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _earningsCard() {
    final daily = asMap(_earnings['daily']);
    final transactions = asMapList(_earnings['transactions']);
    return SectionCard(
      title: 'Заробіток',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('БАЛАНС', style: TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1)),
                  Text(money((_earnings['balanceCents'] as num?)?.toInt() ?? 0),
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                ],
              ),
              const Spacer(),
              if (daily.isNotEmpty)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text('ЗА 7 ДНІВ', style: TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1)),
                    Text('${daily['orders'] ?? 0} поїздок',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  ],
                ),
            ],
          ),
          if (transactions.isNotEmpty) ...[
            const Divider(height: 22),
            ...transactions.take(5).map((txn) {
              final amount = (txn['amount_cents'] as num?)?.toInt() ?? 0;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    Expanded(child: Text('${txn['kind']}', style: const TextStyle(fontSize: 12))),
                    Text(dateTimeText('${txn['created_at']}'),
                        style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                    const SizedBox(width: 10),
                    Text(money(amount),
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: amount >= 0 ? RukhTheme.accent : Colors.white,
                        )),
                  ],
                ),
              );
            }),
          ],
        ],
      ),
    );
  }
}
