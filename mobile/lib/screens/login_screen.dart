import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/demo_login.dart';
import '../core/discovery.dart';
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
  bool _discovering = false;
  int _discoveredCount = 0;
  bool _diagRunning = false;
  List<_EndpointCheck> _diag = <_EndpointCheck>[];

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  /// Старт: спершу беремо свіжий список адрес API з endpoint.json у репозиторії
  /// (стабільне посилання), потім перевіряємо звʼязок. Так демо-вхід працює,
  /// навіть якщо адреса тунелю змінилась після збірки APK.
  Future<void> _bootstrap() async {
    final cached = _cachedEndpoints();
    if (cached.isNotEmpty) {
      widget.session.api.setBaseUrls(<String>[...cached, ...widget.session.api.baseUrls]);
    }
    if (mounted) setState(() => _discovering = true);
    await _refreshEndpoints();
    if (mounted) setState(() => _discovering = false);
    await _checkServer();
  }

  /// Перечитує список живих адрес API і ставить їх першими в черзі.
  /// Ніколи не кидає: якщо GitHub недоступний — лишаються вшиті адреси.
  Future<void> _refreshEndpoints() async {
    try {
      final found = await Discovery().endpoints();
      if (found.isEmpty) return;
      widget.session.api.setBaseUrls(<String>[...found, ...widget.session.api.baseUrls]);
      _discoveredCount = found.length;
      // Кеш останніх робочих адрес: якщо наступного разу GitHub/CDN недоступний,
      // застосунок усе одно спробує адреси, які працювали торік.
      await widget.session.prefs.setStringList('endpoints', found);
    } catch (_) {
      /* виявлення адреси не має ламати вхід */
    }
  }

  /// Адреси, збережені з попереднього успішного запуску (найшвидший шлях).
  List<String> _cachedEndpoints() {
    try {
      return widget.session.prefs.getStringList('endpoints') ?? const <String>[];
    } catch (_) {
      return const <String>[];
    }
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

  /// Демо-вхід одним дотиком.
  ///
  /// Запит іде **паралельно до всіх відомих адрес** — перша успішна відповідь
  /// виграє. Це принципово швидше за послідовні спроби: навіть якщо два тунелі
  /// впали, третій відповідає за секунду, і користувач не бачить «вічного»
  /// спінера.
  Future<void> _demoLogin({String? role, String? phone}) async {
    const rounds = 2;
    setState(() {
      _busy = true;
      _error = null;
      _info = 'Зʼєднуємось із сервером…';
    });

    for (var round = 1; round <= rounds; round++) {
      if (round > 1) {
        if (!mounted) return;
        setState(() => _info = 'Оновлюю адреси й пробую ще раз…');
        await _refreshEndpoints();
      }
      try {
        final result = await raceDemoLogin(
          widget.session.api.baseUrls,
          role: role,
          phone: phone,
        );
        // робоча адреса стає першою для всіх наступних запитів
        widget.session.api.setBaseUrls(<String>[result.endpoint, ...widget.session.api.baseUrls]);
        final map = result.data;
        final token = '${map['token'] ?? ''}';
        if (token.isEmpty) throw ApiException(0, 'no_token', 'Сервер не повернув токен');
        final rawUser = map['user'];
        await widget.session.signIn(
          token,
          rawUser is Map ? Map<String, dynamic>.from(rawUser) : <String, dynamic>{},
        );
        if (mounted) {
          setState(() {
            _busy = false;
            _info = null;
          });
        }
        return;
      } on ApiException catch (e) {
        if (mounted) {
          setState(() {
            _error = e.status == 0
                ? 'Сервер зараз недоступний. Перевірте інтернет і натисніть «Повторити».'
                : e.message;
            _info = null;
            _serverOk = false;
          });
        }
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  /// Паралельна перевірка всіх відомих адрес: показує, яка відповідає,
  /// за скільки мілісекунд і з якою помилкою. Це дає відповідь на питання
  /// «чому не входить» без здогадок.
  Future<void> _runDiagnostics() async {
    setState(() {
      _diagRunning = true;
      _diag = <_EndpointCheck>[];
    });
    await _refreshEndpoints();
    final urls = List<String>.from(widget.session.api.baseUrls);
    final results = await Future.wait(urls.map((url) async {
      final probe = ApiClient(baseUrl: url);
      probe.requestTimeout = const Duration(seconds: 6);
      final watch = Stopwatch()..start();
      try {
        final res = await probe.get('/api/health');
        watch.stop();
        final ok = res is Map && res['ok'] == true;
        return _EndpointCheck(url, ok, watch.elapsedMilliseconds, ok ? null : 'відповідь без ok');
      } on ApiException catch (e) {
        watch.stop();
        return _EndpointCheck(url, false, watch.elapsedMilliseconds, e.message);
      } finally {
        probe.close();
      }
    }));
    if (!mounted) return;
    setState(() {
      _diag = results;
      _diagRunning = false;
      _serverOk = results.any((r) => r.ok);
    });
  }

  Widget _diagnosticsCard() {
    return SectionCard(
      title: 'Перевірка адрес',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final check in _diag) ...[
            Row(
              children: [
                Icon(
                  check.ok ? Icons.check_circle : Icons.cancel,
                  size: 16,
                  color: check.ok ? RukhTheme.success : RukhTheme.danger,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        check.url.replaceFirst(RegExp(r'^https?://'), ''),
                        style: const TextStyle(fontSize: 12),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        check.ok ? 'відповів за ${check.ms} мс' : '${check.error ?? 'помилка'} (${check.ms} мс)',
                        style: const TextStyle(fontSize: 11, color: RukhTheme.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
          Text(
            _diag.any((c) => c.ok)
                ? 'Сервер живий — натисніть «Демо-вхід одним дотиком».'
                : 'Жодна адреса не відповіла. Перевірте інтернет на телефоні. '
                    'Якщо інтернет є — сервер тимчасово недоступний, спробуйте за хвилину '
                    'або введіть іншу адресу через іконку сервера.',
            style: const TextStyle(fontSize: 11, color: RukhTheme.muted, height: 1.4),
          ),
        ],
      ),
    );
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
                if (_discovering)
                  const Text('Шукаю актуальну адресу сервера…',
                      style: TextStyle(color: RukhTheme.muted, fontSize: 11))
                else if (_discoveredCount > 0)
                  Text('Адреси API оновлено з репозиторію ($_discoveredCount)',
                      style: const TextStyle(color: RukhTheme.muted, fontSize: 11))
                else if (_serverInfo != null)
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
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : () => _demoLogin(role: 'passenger'),
                      icon: const Icon(Icons.refresh, size: 18),
                      label: const Text('Повторити'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy || _diagRunning ? null : _runDiagnostics,
                      icon: const Icon(Icons.network_check, size: 18),
                      label: const Text('Діагностика'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
            ],
            if (_diag.isNotEmpty) ...[_diagnosticsCard(), const SizedBox(height: 14)],
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
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : () => _demoLogin(role: 'passenger'),
                icon: _busy
                    ? const SizedBox(
                        width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: RukhTheme.ink))
                    : const Icon(Icons.bolt),
                label: Text(_busy ? 'Зʼєднуємось…' : 'Демо-вхід одним дотиком'),
              ),
            ),
            const SizedBox(height: 10),
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
          border: Border.all(color: RukhTheme.border),
        ),
        child: Text(label, style: const TextStyle(fontSize: 13)),
      ),
    );
  }
}

class _EndpointCheck {
  const _EndpointCheck(this.url, this.ok, this.ms, this.error);

  final String url;
  final bool ok;
  final int ms;
  final String? error;
}
