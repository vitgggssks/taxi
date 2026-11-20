// Демо-вхід «гонкою»: один і той самий запит іде паралельно до всіх відомих
// адрес API, і виграє найшвидша успішна відповідь.
//
// Навіщо: публічні демо-адреси (тунелі) періодично впадають. Послідовні спроби
// з таймаутом 8 с на кожну давали 20+ секунд «спінера» і виглядали як зависання.
// Паралельний запит дає відповідь за час найшвидшої живої адреси (≈1 с).
import 'dart:async';

import 'api.dart';

class DemoLoginResult {
  const DemoLoginResult({required this.endpoint, required this.data});

  /// Адреса, яка відповіла — її треба зробити основною.
  final String endpoint;
  final Map<String, dynamic> data;
}

/// Кидає [ApiException] з кодом `network`, якщо не відповіла жодна адреса.
Future<DemoLoginResult> raceDemoLogin(
  List<String> urls, {
  String? role,
  String? phone,
  Duration timeout = const Duration(seconds: 7),
}) {
  final endpoints = urls.where((u) => u.trim().isNotEmpty).toList();
  if (endpoints.isEmpty) {
    throw ApiException(0, 'no_endpoint', 'Немає жодної адреси сервера');
  }

  final completer = Completer<DemoLoginResult>();
  var pending = endpoints.length;
  var lastError = ApiException(0, 'network', 'Немає звʼязку з сервером');

  for (final endpoint in endpoints) {
    final probe = ApiClient(baseUrl: endpoint);
    probe.requestTimeout = timeout;
    probe
        .post('/api/auth/demo-login', {
          if (role != null) 'role': role,
          if (phone != null) 'phone': phone,
        })
        .then((response) {
      if (completer.isCompleted) return;
      completer.complete(DemoLoginResult(
        endpoint: endpoint,
        data: response is Map ? Map<String, dynamic>.from(response) : <String, dynamic>{},
      ));
    }).catchError((Object error) {
      lastError = error is ApiException ? error : ApiException(0, 'network', 'Немає звʼязку з сервером');
      pending -= 1;
      if (pending <= 0 && !completer.isCompleted) completer.completeError(lastError);
    }).whenComplete(probe.close);
  }

  return completer.future;
}
