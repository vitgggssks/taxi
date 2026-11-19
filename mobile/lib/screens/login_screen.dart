import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.session});

  final Session session;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController(text: '+380');
  final _code = TextEditingController();
  String? _error;
  String? _demoCode;
  String? _info;
  bool _busy = false;
  bool _codeSent = false;
  bool? _serverOk;
  String? _serverInfo;

  @override
  void initState() {
    super.initState();
    _checkServer();
  }

  /// Пінг `/api/health`, щоб користувач одразу бачив, чи живий сервер,
  /// а не ловив «дивну» помилку на демо-вході.
  Future<void> _checkServer() async {
    if (mounted) setState(() => _serverOk = null);
    try {
      final res = await widget.session.api.get('/api/health');
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _serverOk = map['ok'] == true;
        _serverInfo = map['ok'] == true ? '${map['service']} · v${map['version']}' : null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _serverOk = false;
        _serverInfo = e.message;
      });
    }
  }

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _requestOtp() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await widget.session.api.post('/api/auth/request-otp', {'phone': _phone.text.trim()});
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      setState(() {
        _codeSent = true;
        _demoCode = map['demoCode']?.toString();
        _info = map['isNewUser'] == true
            ? 'Новий номер — акаунт створиться автоматично'
            : 'Код надіслано на ${_phone.text.trim()}';
        if (_demoCode != null) _code.text = _demoCode!;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await widget.session.api.post('/api/auth/verify-otp', {
        'phone': _phone.text.trim(),
        'code': _code.text.trim(),
      });
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      await widget.session.signIn('${map['token']}', Map<String, dynamic>.from(map['user'] as Map));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _demoLogin({String? role, String? phone}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await widget.session.api.post('/api/auth/demo-login', {
        if (role != null) 'role': role,
        if (phone != null) 'phone': phone,
      });
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      await widget.session.signIn('${map['token']}', Map<String, dynamic>.from(map['user'] as Map));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _editServer() async {
    final controller = TextEditingController(text: widget.session.api.baseUrl);
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Адреса сервера'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(hintText: 'http://192.168.0.10:3000'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Скасувати')),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const Text('Зберегти'),
          ),
        ],
      ),
    );
    if (result != null && result.trim().isNotEmpty) {
      await widget.session.setBaseUrl(result);
      if (!mounted) return;
      setState(() => _info = 'Сервер: ${widget.session.api.baseUrl}');
      await _checkServer();
    }
  }

  Widget _serverBanner() {
    final ok = _serverOk;
    final color = ok == null ? RukhTheme.muted : (ok ? RukhTheme.accent : RukhTheme.danger);
    final label = ok == null
        ? 'Перевіряю сервер…'
        : ok
            ? 'Сервер доступний'
            : 'Сервер недоступний';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          Icon(ok == null ? Icons.sync : (ok ? Icons.check_circle_outline : Icons.cloud_off),
              size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
                if (_serverInfo != null)
                  Text(
                    _serverInfo!,
                    style: const TextStyle(color: RukhTheme.muted, fontSize: 11),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
              ],
            ),
          ),
          if (ok == false)
            TextButton(
              onPressed: _editServer,
              style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)),
              child: const Text('Змінити', style: TextStyle(fontSize: 12)),
            ),
          IconButton(
            onPressed: _checkServer,
            icon: const Icon(Icons.refresh, size: 16, color: RukhTheme.muted),
            tooltip: 'Перевірити ще раз',
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final api = widget.session.api;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 28, 20, 24),
          children: [
            Row(
              children: [
                const BrandMark(size: 52, label: 'Р'),
                const SizedBox(width: 12),
                const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('РУХ', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 2)),
                    Text('ТАКСІ · ДОСТАВКА', style: TextStyle(color: RukhTheme.muted, fontSize: 11, letterSpacing: 2)),
                  ],
                ),
                const Spacer(),
                IconButton(
                  onPressed: _editServer,
                  icon: const Icon(Icons.dns_outlined),
                  tooltip: 'Адреса сервера',
                ),
              ],
            ),
            const SizedBox(height: 28),
            const Text('Вхід за номером телефону', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(
              'Сервер: ${api.baseUrl.replaceAll(RegExp(r'^https?://'), '')}',
              style: const TextStyle(color: RukhTheme.muted, fontSize: 12),
            ),
            const SizedBox(height: 14),
            _serverBanner(),
            const SizedBox(height: 14),
            if (_error != null) ...[
              ErrorBox(message: _error!),
              const SizedBox(height: 14),
            ],
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              enabled: !_codeSent,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))],
              decoration: const InputDecoration(labelText: 'Телефон', hintText: '+380671112233'),
            ),
            if (_codeSent) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'Код з SMS', hintText: '4 цифри'),
              ),
              if (_info != null) ...[
                const SizedBox(height: 10),
                Text(_info!, style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
              ],
              if (_demoCode != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: RukhTheme.warning.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.info_outline, size: 18, color: RukhTheme.warning),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'SMS-шлюз не підключено (demo): код $_demoCode вже підставлено',
                          style: const TextStyle(color: RukhTheme.warning, fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
            const SizedBox(height: 18),
            FilledButton(
              onPressed: _busy ? null : (_codeSent ? _verify : _requestOtp),
              child: _busy
                  ? const SizedBox(
                      height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: RukhTheme.ink))
                  : Text(_codeSent ? 'Увійти' : 'Отримати код'),
            ),
            if (_codeSent)
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                          _codeSent = false;
                          _demoCode = null;
                          _info = null;
                          _error = null;
                        }),
                child: const Text('Змінити номер'),
              ),
            const SizedBox(height: 26),
            Row(children: [
              const Expanded(child: Divider()),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text('демо-доступ', style: TextStyle(color: RukhTheme.muted.withValues(alpha: 0.9), fontSize: 12)),
              ),
              const Expanded(child: Divider()),
            ]),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _DemoChip(label: 'Пасажир', onTap: () => _demoLogin(role: 'passenger')),
                _DemoChip(label: 'Водій', onTap: () => _demoLogin(phone: '+380671000102')),
                _DemoChip(label: 'Диспетчер', onTap: () => _demoLogin(role: 'dispatcher')),
                _DemoChip(label: 'Адмін', onTap: () => _demoLogin(role: 'admin')),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              'Демо-вхід працює лише коли сервер доступний. Якщо банер вище червоний — '
              'натисніть «Змінити» і вкажіть адресу API (для телефона це IP компʼютера '
              'у Wi-Fi, наприклад http://192.168.0.10:3000).',
              style: TextStyle(color: RukhTheme.muted.withValues(alpha: 0.85), fontSize: 11, height: 1.4),
            ),
            const SizedBox(height: 12),
            Text(
              'Коди повертає лише demo-режим. У проді — SMS через провайдера, токен '
              'зберігається локально і перевіряється на кожному запиті.',
              style: TextStyle(color: RukhTheme.muted.withValues(alpha: 0.75), fontSize: 11, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}

class _DemoChip extends StatelessWidget {
  const _DemoChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 13)),
      ),
    );
  }
}
