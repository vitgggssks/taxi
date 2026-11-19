import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/session.dart';
import '../theme.dart';
import 'order_screen.dart';
import 'shell.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  bool _loading = true;
  String? _error;
  List<Order> _orders = [];
  String _filter = 'all';

  static const _filters = <String, String>{
    'all': 'Усі',
    'active': 'Активні',
    'completed': 'Завершені',
    'canceled': 'Скасовані',
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final query = <String, String>{'limit': '50'};
      if (_filter == 'active') {
        query['status'] = 'searching,offered,no_drivers,assigned,driver_arriving,waiting,in_progress';
      } else if (_filter == 'completed') {
        query['status'] = 'completed';
      } else if (_filter == 'canceled') {
        query['status'] = 'canceled,expired';
      }
      final res = await widget.api.get('/api/orders', query);
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() => _orders = items.map(Order.fromJson).toList());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: RukhAppBar(
        title: 'Історія',
        subtitle: '${_orders.length} замовлень',
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))],
      ),
      body: Column(
        children: [
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: _filters.entries.map((entry) {
                final selected = _filter == entry.key;
                return Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(entry.value),
                    selected: selected,
                    onSelected: (value) {
                      if (!value) return;
                      setState(() => _filter = entry.key);
                      _load();
                    },
                    selectedColor: RukhTheme.accent,
                    labelStyle: TextStyle(color: selected ? RukhTheme.ink : Colors.white, fontSize: 12),
                    backgroundColor: RukhTheme.surfaceAlt,
                    side: BorderSide.none,
                  ),
                );
              }).toList(),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _load,
                    child: _error != null
                        ? ListView(padding: const EdgeInsets.all(16), children: [ErrorBox(message: _error!)])
                        : _orders.isEmpty
                            ? ListView(
                                padding: const EdgeInsets.all(32),
                                children: const [
                                  Icon(Icons.receipt_long_outlined, size: 42, color: RukhTheme.muted),
                                  SizedBox(height: 12),
                                  Text('Замовлень ще немає',
                                      textAlign: TextAlign.center, style: TextStyle(color: RukhTheme.muted)),
                                ],
                              )
                            : ListView.separated(
                                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                                itemCount: _orders.length,
                                separatorBuilder: (context, index) => const SizedBox(height: 10),
                                itemBuilder: (context, index) => _OrderTile(
                                  order: _orders[index],
                                  onTap: () async {
                                    await Navigator.of(context).push(
                                      MaterialPageRoute(
                                        builder: (_) => OrderScreen(
                                          api: widget.api,
                                          session: widget.session,
                                          orderId: _orders[index].id,
                                        ),
                                      ),
                                    );
                                    if (mounted) await _load();
                                  },
                                ),
                              ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order, required this.onTap});

  final Order order;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: RukhTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Colors.white.withValues(alpha: 0.05)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('№${order.number}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                const SizedBox(width: 8),
                StatusChip(status: order.status),
                const Spacer(),
                Text(money(order.priceCents), style: const TextStyle(fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 8),
            Text(order.pickupAddress, style: const TextStyle(fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(order.dropoffAddress,
                style: const TextStyle(fontSize: 13, color: RukhTheme.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(dateTimeText(order.createdAt), style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                const SizedBox(width: 10),
                Text(serviceLabel(order.serviceKind), style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                const Spacer(),
                if (order.rating != null)
                  Row(
                    children: List.generate(
                      5,
                      (i) => Icon(i < order.rating! ? Icons.star : Icons.star_border,
                          size: 12, color: RukhTheme.accent),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
