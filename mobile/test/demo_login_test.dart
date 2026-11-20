// Демо-вхід має бути швидким і не залежати від того, скільки адрес впало.
// Перевіряємо гонку: мертва адреса + жива → вхід проходить із живої.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/api.dart';
import 'package:rukh_mobile/core/demo_login.dart';

Future<HttpServer> _apiServer({int status = 200, Map<String, dynamic>? body}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest request) async {
    await utf8.decoder.bind(request).join();
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
    request.response.write(jsonEncode(body ?? {'token': 'tok', 'user': {'id': 'usr_1', 'role': 'passenger'}}));
    await request.response.close();
  });
  return server;
}

void main() {
  test('вхід проходить через живу адресу, навіть якщо перша мертва', () async {
    final alive = await _apiServer();
    addTearDown(() => alive.close(force: true));
    final watch = Stopwatch()..start();

    final result = await raceDemoLogin(
      ['http://127.0.0.1:1', 'http://127.0.0.1:${alive.port}'],
      role: 'passenger',
      timeout: const Duration(seconds: 3),
    );
    watch.stop();

    expect(result.endpoint, 'http://127.0.0.1:${alive.port}');
    expect(result.data['token'], 'tok');
    expect(watch.elapsedMilliseconds, lessThan(3000), reason: 'не має чекати мертву адресу');
  });

  test('якщо всі адреси мертві — швидка помилка, а не зависання', () async {
    final watch = Stopwatch()..start();
    await expectLater(
      raceDemoLogin(['http://127.0.0.1:1', 'http://127.0.0.1:2'], timeout: const Duration(seconds: 2)),
      throwsA(isA<ApiException>()),
    );
    watch.stop();
    expect(watch.elapsedMilliseconds, lessThan(4000));
  });

  test('порожній список адрес дає зрозумілу помилку', () {
    expect(() => raceDemoLogin(const []), throwsA(isA<ApiException>()));
  });

  test('500 від сервера не вважається успіхом', () async {
    final broken = await _apiServer(status: 500, body: {'error': {'code': 'internal_error', 'message': 'oops'}});
    addTearDown(() => broken.close(force: true));
    await expectLater(
      raceDemoLogin(['http://127.0.0.1:${broken.port}'], timeout: const Duration(seconds: 3)),
      throwsA(isA<ApiException>()),
    );
  });
}
