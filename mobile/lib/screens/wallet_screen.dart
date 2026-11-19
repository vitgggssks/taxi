import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/session.dart';
import '../theme.dart';
import 'shell.dart';

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  bool _loading = true;
  String? _error;
  int _balance = 0;
  int _bonus = 0;
  List<WalletTxn> _transactions = [];
  bool _busy = false;

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
      final res = await widget.api.get('/api/wallet');
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _balance = (map['balanceCents'] as num?)?.toInt() ?? 0;
        _bonus = (map['bonusCents'] as num?)?.toInt() ?? 0;
        _transactions = asMapList(map['transactions']).map(WalletTxn.fromJson).toList();
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _topUp() async {
    final controller = TextEditingController(text: '200');
    final amount = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Поповнити баланс'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Сума, ₴'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Поповнити')),
        ],
      ),
    );
    if (amount == null) return;
    final hryvnia = int.tryParse(amount.trim());
    if (hryvnia == null || hryvnia <= 0) {
      showError(context, 'Некоректна сума');
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.api.post('/api/wallet/topup', {'amountCents': hryvnia * 100});
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Баланс поповнено на ${money(hryvnia * 100)}')));
      }
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: RukhAppBar(
        title: 'Гаманець',
        subtitle: 'Баланс і транзакції',
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          children: [
            if (_error != null) ...[ErrorBox(message: _error!), const SizedBox(height: 12)],
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [RukhTheme.accent.withValues(alpha: 0.22), RukhTheme.surface],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: RukhTheme.accent.withValues(alpha: 0.25)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('ОСНОВНИЙ БАЛАНС',
                      style: TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1.2)),
                  const SizedBox(height: 6),
                  Text(_loading ? '—' : money(_balance),
                      style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const Icon(Icons.card_giftcard, size: 16, color: RukhTheme.accent),
                      const SizedBox(width: 6),
                      Text('Бонуси: ${money(_bonus)}',
                          style: const TextStyle(color: RukhTheme.accent, fontSize: 13)),
                      const Spacer(),
                      FilledButton.tonal(
                        onPressed: _busy ? null : _topUp,
                        style: FilledButton.styleFrom(minimumSize: const Size(0, 40), padding: const EdgeInsets.symmetric(horizontal: 16)),
                        child: const Text('Поповнити'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            SectionCard(
              title: 'Транзакції',
              child: _loading
                  ? const Center(
                      child: Padding(padding: EdgeInsets.all(20), child: CircularProgressIndicator(strokeWidth: 2)))
                  : _transactions.isEmpty
                      ? const Padding(
                          padding: EdgeInsets.symmetric(vertical: 16),
                          child: Text('Транзакцій ще немає', style: TextStyle(color: RukhTheme.muted, fontSize: 12)),
                        )
                      : Column(
                          children: _transactions.map((txn) {
                            final positive = txn.amountCents >= 0;
                            return Padding(
                              padding: const EdgeInsets.symmetric(vertical: 7),
                              child: Row(
                                children: [
                                  Icon(
                                    positive ? Icons.arrow_downward : Icons.arrow_upward,
                                    size: 16,
                                    color: positive ? RukhTheme.accent : RukhTheme.warning,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(_kindLabel(txn.kind), style: const TextStyle(fontSize: 13)),
                                        Text(dateTimeText(txn.createdAt),
                                            style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                                      ],
                                    ),
                                  ),
                                  Text(
                                    money(txn.amountCents),
                                    style: TextStyle(
                                      fontWeight: FontWeight.w600,
                                      color: positive ? RukhTheme.accent : Colors.white,
                                    ),
                                  ),
                                ],
                              ),
                            );
                          }).toList(),
                        ),
            ),
          ],
        ),
      ),
    );
  }

  String _kindLabel(String kind) => switch (kind) {
        'topup' => 'Поповнення',
        'ride_payment' || 'payment' => 'Оплата поїздки',
        'cashback' => 'Кешбек',
        'commission' => 'Комісія платформи',
        'earning' || 'driver_earning' => 'Заробіток',
        'refund' => 'Повернення',
        'cancel_fee' => 'Компенсація',
        'adjustment' => 'Коригування',
        _ => kind,
      };
}
