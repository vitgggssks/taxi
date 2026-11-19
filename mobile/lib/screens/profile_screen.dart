import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/session.dart';
import '../theme.dart';
import '../widgets/address_picker.dart';
import 'shell.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  List<Map<String, dynamic>> _addresses = [];
  List<Map<String, dynamic>> _notifications = [];
  List<Map<String, dynamic>> _tickets = [];
  bool _loading = true;
  String? _error;

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
      final results = await Future.wait([
        widget.api.get('/api/me/addresses'),
        widget.api.get('/api/me/notifications'),
        widget.api.get('/api/support/tickets'),
      ]);
      List<Map<String, dynamic>> items(Object? res, String key) =>
          res is Map ? asMapList(res[key]) : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _addresses = items(results[0], 'items');
        _notifications = items(results[1], 'items');
        _tickets = items(results[2], 'items');
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _addAddress() async {
    final cityId = widget.session.user?['city_id'];
    final city = cityId == null ? null : await _firstCityId();
    if (city == null) {
      if (mounted) showError(context, 'Немає міст для пошуку адреси');
      return;
    }
    final picked = await pickAddress(context, api: widget.api, cityId: city, title: 'Зберегти адресу');
    if (picked == null || !mounted) return;
    final labelController = TextEditingController(text: 'Дім');
    final label = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Назва адреси'),
        content: TextField(controller: labelController, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, labelController.text.trim()), child: const Text('Зберегти')),
        ],
      ),
    );
    if (label == null || label.isEmpty) return;
    try {
      await widget.api.post('/api/me/addresses', {
        'label': label,
        'address': picked.label,
        'lat': picked.lat,
        'lng': picked.lng,
      });
      await _load();
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<String?> _firstCityId() async {
    try {
      final res = await widget.api.get('/api/cities');
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      return items.isEmpty ? null : '${items.first['id']}';
    } on ApiException {
      return null;
    }
  }

  Future<void> _deleteAddress(String id) async {
    try {
      await widget.api.delete('/api/me/addresses/$id');
      await _load();
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editName() async {
    final controller = TextEditingController(text: '${widget.session.user?['name'] ?? ''}');
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Як до вас звертатися?'),
        content: TextField(controller: controller, autofocus: true, decoration: const InputDecoration(labelText: 'Імʼя')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('Зберегти')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    try {
      await widget.session.updateProfile(name: name);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _newTicket() async {
    final subject = TextEditingController();
    final message = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Нове звернення'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: subject, decoration: const InputDecoration(labelText: 'Тема')),
            const SizedBox(height: 10),
            TextField(
              controller: message,
              maxLines: 4,
              decoration: const InputDecoration(labelText: 'Опишіть ситуацію'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Надіслати')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.post('/api/support/tickets', {
        'subject': subject.text.trim(),
        'message': message.text.trim(),
      });
      await _load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Звернення створено')));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editServer() async {
    final controller = TextEditingController(text: widget.api.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Адреса API'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(hintText: 'http://10.0.2.2:3000'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Зберегти')),
        ],
      ),
    );
    if (url == null || url.trim().isEmpty) return;
    await widget.session.setBaseUrl(url);
    if (mounted) setState(() {});
  }

  Future<void> _signOut() async {
    await widget.session.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    final unread = _notifications.where((n) => n['read_at'] == null).length;
    return Scaffold(
      appBar: RukhAppBar(
        title: 'Профіль',
        subtitle: session.role,
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          children: [
            if (_error != null) ...[ErrorBox(message: _error!), const SizedBox(height: 12)],
            SectionCard(
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 26,
                    backgroundColor: RukhTheme.accent.withValues(alpha: 0.16),
                    child: Text(
                      session.displayName.isEmpty ? 'Р' : session.displayName.substring(0, 1).toUpperCase(),
                      style: const TextStyle(color: RukhTheme.accent, fontSize: 20, fontWeight: FontWeight.w700),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(session.displayName, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                        Text(session.phone, style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
                      ],
                    ),
                  ),
                  IconButton(onPressed: _editName, icon: const Icon(Icons.edit_outlined, size: 20)),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SectionCard(
              title: 'Мої адреси',
              child: Column(
                children: [
                  if (_loading && _addresses.isEmpty)
                    const Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator(strokeWidth: 2))
                  else if (_addresses.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('Збережіть адреси для швидкого замовлення',
                          style: TextStyle(color: RukhTheme.muted, fontSize: 12)),
                    ),
                  ..._addresses.map(
                    (a) => Row(
                      children: [
                        const Icon(Icons.bookmark_border, size: 18, color: RukhTheme.muted),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${a['label']}', style: const TextStyle(fontSize: 13)),
                              Text('${a['address']}',
                                  style: const TextStyle(color: RukhTheme.muted, fontSize: 11),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis),
                            ],
                          ),
                        ),
                        IconButton(
                          onPressed: () => _deleteAddress('${a['id']}'),
                          icon: const Icon(Icons.close, size: 16, color: RukhTheme.muted),
                        ),
                      ],
                    ),
                  ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _addAddress,
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('Додати адресу'),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SectionCard(
              title: 'Сповіщення${unread > 0 ? ' ($unread нових)' : ''}',
              child: _notifications.isEmpty
                  ? const Text('Сповіщень немає', style: TextStyle(color: RukhTheme.muted, fontSize: 12))
                  : Column(
                      children: _notifications.take(6).map((n) {
                        return Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(
                                n['read_at'] == null ? Icons.circle : Icons.circle_outlined,
                                size: 8,
                                color: RukhTheme.accent,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('${n['title']}', style: const TextStyle(fontSize: 13)),
                                    if ('${n['body'] ?? ''}'.isNotEmpty)
                                      Text('${n['body']}',
                                          style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                                    Text(dateTimeText('${n['created_at']}'),
                                        style: const TextStyle(color: RukhTheme.muted, fontSize: 10)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
            ),
            const SizedBox(height: 12),
            SectionCard(
              title: 'Підтримка 24/7',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_tickets.isEmpty)
                    const Text('Звернень немає', style: TextStyle(color: RukhTheme.muted, fontSize: 12)),
                  ..._tickets.take(3).map(
                        (t) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Row(
                            children: [
                              const Icon(Icons.confirmation_number_outlined, size: 16, color: RukhTheme.muted),
                              const SizedBox(width: 8),
                              Expanded(child: Text('${t['subject']}', style: const TextStyle(fontSize: 12))),
                              Text('${t['status']}', style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
                            ],
                          ),
                        ),
                      ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _newTicket,
                      icon: const Icon(Icons.support_agent, size: 18),
                      label: const Text('Написати в підтримку'),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SectionCard(
              title: 'Зʼєднання',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.api.baseUrl, style: const TextStyle(fontSize: 13)),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _editServer,
                    icon: const Icon(Icons.dns_outlined, size: 18),
                    label: const Text('Змінити адресу API'),
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _signOut,
              icon: const Icon(Icons.logout),
              label: const Text('Вийти'),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(50),
                foregroundColor: RukhTheme.danger,
                side: BorderSide(color: RukhTheme.danger.withValues(alpha: 0.4)),
              ),
            ),
            const SizedBox(height: 12),
            Center(
              child: Text('РУХ · версія 0.1.0',
                  style: TextStyle(color: RukhTheme.muted.withValues(alpha: 0.7), fontSize: 11)),
            ),
          ],
        ),
      ),
    );
  }
}
