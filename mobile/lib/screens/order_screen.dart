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

/// Картка замовлення: живий статус через WebSocket + дії пасажира.
class OrderScreen extends StatefulWidget {
  const OrderScreen({
    super.key,
    required this.api,
    required this.session,
    required this.orderId,
  });

  final ApiClient api;
  final Session session;
  final String orderId;

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> {
  Order? _order;
  String? _error;
  bool _loading = true;
  bool _actionBusy = false;
  Realtime? _realtime;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    _realtime = Realtime(
      api: widget.api,
      onEvent: (event, payload) {
        if (event == 'order.updated' && payload is Map && '${payload['id']}' == widget.orderId) {
          if (mounted) setState(() => _order = Order.fromJson(Map<String, dynamic>.from(payload)));
        }
      },
    )..connect();
    _realtime!.subscribe('order:${widget.orderId}');
    _poll = Timer.periodic(const Duration(seconds: 8), (_) {
      final order = _order;
      if (order == null || order.isActive) _load(silent: true);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _realtime?.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await widget.api.get('/api/orders/${widget.orderId}');
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _order = Order.fromJson(asMap(map['order']));
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (!silent) setState(() => _error = e.message);
    } finally {
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  Future<void> _cancel() async {
    final reason = await _askReason();
    if (reason == null) return;
    setState(() => _actionBusy = true);
    try {
      await widget.api.post('/api/orders/${widget.orderId}/cancel', {'reason': reason});
      await _load(silent: true);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Замовлення скасовано')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<String?> _askReason() async {
    final controller = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Скасувати замовлення?'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(labelText: 'Причина', hintText: 'Наприклад: змінилися плани'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Ні')),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim().isEmpty ? 'Скасовано клієнтом' : controller.text.trim()),
            child: const Text('Скасувати замовлення'),
          ),
        ],
      ),
    );
    return value;
  }

  Future<void> _rate() async {
    int stars = 5;
    final controller = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: const Text('Оцініть поїздку'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(5, (i) {
                  return IconButton(
                    onPressed: () => setLocal(() => stars = i + 1),
                    icon: Icon(
                      i < stars ? Icons.star : Icons.star_border,
                      color: RukhTheme.accent,
                      size: 30,
                    ),
                  );
                }),
              ),
              TextField(
                controller: controller,
                decoration: const InputDecoration(labelText: 'Коментар (необовʼязково)'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Пізніше')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Надіслати')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    setState(() => _actionBusy = true);
    try {
      await widget.api.post('/api/orders/${widget.orderId}/rate', {
        'rating': stars,
        if (controller.text.trim().isNotEmpty) 'text': controller.text.trim(),
      });
      await _load(silent: true);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Дякуємо за відгук!')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _pay() async {
    setState(() => _actionBusy = true);
    try {
      final res = await widget.api.post('/api/orders/${widget.orderId}/pay', {'method': _order?.paymentMethod});
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      setState(() => _order = Order.fromJson(asMap(map['order'])));
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Оплату проведено')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _repeat() async {
    setState(() => _actionBusy = true);
    try {
      final res = await widget.api.post('/api/orders/${widget.orderId}/repeat');
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      final newOrder = Order.fromJson(asMap(map['order']));
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => OrderScreen(api: widget.api, session: widget.session, orderId: newOrder.id),
        ),
      );
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final order = _order;
    return Scaffold(
      appBar: RukhAppBar(
        title: order == null ? 'Замовлення' : '№${order.number}',
        subtitle: order == null ? null : serviceLabel(order.serviceKind),
        actions: [
          IconButton(onPressed: () => _load(), icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : order == null
              ? Center(child: ErrorBox(message: _error ?? 'Замовлення не знайдено'))
              : RefreshIndicator(
                  onRefresh: () => _load(),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
                    children: [
                      _statusHeader(order),
                      const SizedBox(height: 12),
                      const SizedBox(height: 12),
                      _mapCard(order),
                      if (order.isActive) ...[const SizedBox(height: 12), _timeline(order), const SizedBox(height: 12)],
                      if (order.driver != null) ...[_driverCard(order), const SizedBox(height: 12)],
                      _routeCard(order),
                      const SizedBox(height: 12),
                      _paymentCard(order),
                      if (order.delivery != null) ...[const SizedBox(height: 12), _deliveryCard(order)],
                      if (order.cancelReason != null) ...[
                        const SizedBox(height: 12),
                        SectionCard(
                          title: 'Скасування',
                          child: Text(order.cancelReason!, style: const TextStyle(color: RukhTheme.muted)),
                        ),
                      ],
                      const SizedBox(height: 20),
                      ..._actions(order),
                    ],
                  ),
                ),
    );
  }

  Widget _statusHeader(Order order) {
    return SectionCard(
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: statusColor(order.status).withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(_statusIcon(order.status), color: statusColor(order.status)),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(statusLabel(order.status),
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(
                  [
                    dateTimeText(order.createdAt),
                    if (order.scheduledAt != null) 'подача ${dateTimeText(order.scheduledAt)}',
                  ].join(' · '),
                  style: const TextStyle(color: RukhTheme.muted, fontSize: 11),
                ),
              ],
            ),
          ),
          if (order.isActive)
            const SizedBox(
              height: 18,
              width: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: RukhTheme.accent),
            ),
        ],
      ),
    );
  }

  IconData _statusIcon(String status) => switch (status) {
        'searching' || 'offered' => Icons.radar,
        'no_drivers' => Icons.person_off_outlined,
        'assigned' => Icons.person_pin_circle_outlined,
        'driver_arriving' => Icons.directions_car,
        'waiting' => Icons.hourglass_bottom,
        'in_progress' => Icons.navigation,
        'completed' => Icons.check_circle_outline,
        _ => Icons.cancel_outlined,
      };

  Widget _mapCard(Order order) {
    final points = order.points.map((p) => MapPoint(p.lat, p.lng)).toList();
    if (points.isEmpty) return const SizedBox.shrink();
    final driverPoint = (order.driver?.lat != null && order.driver?.lng != null)
        ? MapPoint(order.driver!.lat!, order.driver!.lng!)
        : null;
    final all = driverPoint == null ? points : [...points, driverPoint];
    final focus = MapFocus.fit(all, viewport: const Size(340, 230));
    final markers = <MapMarker>[
      MapPins.pickupPin(points.first, label: 'Звідки'),
      if (points.length > 1) MapPins.dropoffPin(points.last, label: 'Куди'),
      for (var i = 1; i < points.length - 1; i++) MapPins.stopPin(points[i]),
      if (driverPoint != null) MapPins.driverPin(driverPoint),
    ];
    return SectionCard(
      title: 'На мапі',
      padding: const EdgeInsets.fromLTRB(10, 16, 10, 10),
      child: OsmMap(
        center: focus.center,
        zoom: focus.zoom,
        markers: markers,
        route: points,
        height: 230,
      ),
    );
  }

  Widget _timeline(Order order) {
    final current = orderTimeline.indexOf(order.status);
    return SectionCard(
      title: 'Статус',
      child: Column(
        children: [
          for (int i = 0; i < orderTimeline.length; i++)
            Builder(builder: (context) {
              final label = statusLabel(orderTimeline[i]);
              final passed = current >= i;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    Icon(
                      passed ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                      size: 16,
                      color: passed ? RukhTheme.accent : RukhTheme.muted.withValues(alpha: 0.5),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      label,
                      style: TextStyle(
                        fontSize: 13,
                        color: passed ? Colors.white : RukhTheme.muted,
                        fontWeight: passed ? FontWeight.w600 : FontWeight.w400,
                      ),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _driverCard(Order order) {
    final driver = order.driver!;
    final vehicle = order.vehicle;
    return SectionCard(
      title: 'Водій',
      child: Row(
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: RukhTheme.accent.withValues(alpha: 0.15),
            child: Text(
              driver.name.characters.first.toUpperCase(),
              style: const TextStyle(color: RukhTheme.accent, fontWeight: FontWeight.w700, fontSize: 18),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(driver.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Row(
                  children: [
                    const Icon(Icons.star, size: 13, color: RukhTheme.accent),
                    const SizedBox(width: 3),
                    Text(driver.rating.toStringAsFixed(2),
                        style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
                    const SizedBox(width: 10),
                    Text(driver.phone, style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
                  ],
                ),
              ],
            ),
          ),
          if (vehicle != null)
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(vehicle.title, style: const TextStyle(fontSize: 12)),
                Text(vehicle.plate, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
              ],
            ),
        ],
      ),
    );
  }

  Widget _routeCard(Order order) {
    return SectionCard(
      title: 'Маршрут',
      child: Column(
        children: [
          for (final point in order.points)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    margin: const EdgeInsets.only(top: 5),
                    width: 9,
                    height: 9,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: point.kind == 'pickup'
                          ? RukhTheme.accent
                          : point.kind == 'dropoff'
                              ? const Color(0xFFB47BFF)
                              : RukhTheme.warning,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(child: Text(point.address, style: const TextStyle(fontSize: 14))),
                ],
              ),
            ),
          const Divider(height: 20),
          Row(
            children: [
              Text('${distanceText(order.distanceM)} · ${durationText(order.durationS)}',
                  style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
              const Spacer(),
              Text(money(order.priceCents), style: const TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
          if (order.comment != null && order.comment!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Коментар: ${order.comment}',
                  style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
            ),
        ],
      ),
    );
  }

  Widget _paymentCard(Order order) {
    return SectionCard(
      title: 'Оплата',
      child: Column(
        children: [
          Row(
            children: [
              Text(paymentLabel(order.paymentMethod), style: const TextStyle(fontSize: 14)),
              const Spacer(),
              _pill(
                order.paymentStatus == 'paid' ? 'оплачено' : 'очікує',
                order.paymentStatus == 'paid' ? RukhTheme.accent : RukhTheme.warning,
              ),
            ],
          ),
          if (order.cashbackCents > 0) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.card_giftcard, size: 15, color: RukhTheme.accent),
                const SizedBox(width: 6),
                Text('Кешбек ${money(order.cashbackCents)} на бонусний рахунок',
                    style: const TextStyle(fontSize: 12, color: RukhTheme.accent)),
              ],
            ),
          ],
          if (order.rating != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('Ваша оцінка: ', style: TextStyle(fontSize: 12, color: RukhTheme.muted)),
                for (int i = 0; i < 5; i++)
                  Icon(i < order.rating! ? Icons.star : Icons.star_border, size: 14, color: RukhTheme.accent),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _deliveryCard(Order order) {
    final delivery = order.delivery!;
    return SectionCard(
      title: 'Доставка',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${delivery['sender_name']} → ${delivery['recipient_name']}',
              style: const TextStyle(fontSize: 14)),
          const SizedBox(height: 4),
          Text('Вага: ${delivery['weight_kg']} кг',
              style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _codeBox('Код відправника', '${delivery['pickup_code']}')),
              const SizedBox(width: 8),
              Expanded(child: _codeBox('Код отримувача', '${delivery['dropoff_code']}')),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            delivery['delivered_at'] != null
                ? 'Доставлено ${'${delivery['delivered_at']}'.split('T').first} ${'${delivery['delivered_at']}'.split('T').last.substring(0, 5)}'
                : delivery['picked_up_at'] != null
                    ? 'Посилку забрано курʼєром, прямує до отримувача'
                    : 'Коди покажіть відправнику та отримувачу — без них курʼєр не передасть посилку',
            style: const TextStyle(color: RukhTheme.muted, fontSize: 12, height: 1.35),
          ),
          if (delivery['photo_proof_url'] != null) ...[
            const SizedBox(height: 10),
            GestureDetector(
              onTap: () => showDialog<void>(
                context: context,
                builder: (context) => Dialog(
                  child: InteractiveViewer(
                    child: Image.network(widget.api.absoluteUrl('${delivery['photo_proof_url']}'),
                        errorBuilder: (_, __, ___) => const Padding(
                              padding: EdgeInsets.all(24),
                              child: Text('Не вдалося завантажити фото'),
                            )),
                  ),
                ),
              ),
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.network(
                      widget.api.absoluteUrl('${delivery['photo_proof_url']}'),
                      width: 64,
                      height: 64,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(
                        width: 64,
                        height: 64,
                        color: RukhTheme.surfaceAlt,
                        child: const Icon(Icons.image_not_supported_outlined, size: 18),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text('Фото вручення — натисніть, щоб збільшити',
                        style: TextStyle(fontSize: 12, color: RukhTheme.muted)),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _codeBox(String label, String code) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
      decoration: BoxDecoration(
        color: RukhTheme.surfaceAlt,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: RukhTheme.muted, fontSize: 10)),
          Text(code, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: 3)),
        ],
      ),
    );
  }

  Widget _pill(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(text, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
    );
  }

  List<Widget> _actions(Order order) {
    final widgets = <Widget>[];
    if (order.isActive) {
      widgets.add(
        OutlinedButton.icon(
          onPressed: _actionBusy ? null : _cancel,
          icon: const Icon(Icons.close),
          label: const Text('Скасувати замовлення'),
          style: OutlinedButton.styleFrom(
            minimumSize: const Size.fromHeight(52),
            foregroundColor: RukhTheme.danger,
            side: BorderSide(color: RukhTheme.danger.withValues(alpha: 0.5)),
          ),
        ),
      );
    }
    if (order.status == 'completed') {
      if (order.canRate) {
        widgets.add(
          FilledButton.icon(onPressed: _actionBusy ? null : _rate, icon: const Icon(Icons.star_border), label: const Text('Оцінити поїздку')),
        );
        widgets.add(const SizedBox(height: 8));
      }
      if (order.paymentStatus != 'paid' && order.paymentMethod != 'cash') {
        widgets.add(
          FilledButton.tonalIcon(onPressed: _actionBusy ? null : _pay, icon: const Icon(Icons.credit_card), label: const Text('Оплатити')),
        );
        widgets.add(const SizedBox(height: 8));
      }
    }
    if (!order.isActive) {
      widgets.add(
        OutlinedButton.icon(
          onPressed: _actionBusy ? null : _repeat,
          icon: const Icon(Icons.repeat),
          label: const Text('Повторити замовлення'),
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
        ),
      );
    }
    return widgets;
  }
}
