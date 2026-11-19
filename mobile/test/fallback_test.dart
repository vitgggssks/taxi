// Тести фолбеку адрес API: якщо основна адреса недоступна (мережа або 5xx),
// клієнт має автоматично перемкнутись на резервну і працювати далі з неї.
// Помилки 4xx — це відповідь сервера, перемикатись на інший хост не потрібно.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/api.dart';

Future<HttpServer> _serve(int status, Map<String, dynamic> body) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest request) async {
    await utf8.decoder.bind(request).join();
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
    request.response.write(jsonEncode(body));
    await request.response.close();
  });
  return server;
}

void main() {
  test('перемикається на резервну адресу при 5xx', () async {
    final broken = await _serve(503, {'error': {'code': 'unavailable', 'message': 'немає'}});
    final healthy = await _serve(200, {'ok': true, 'source': 'fallback'});
    addTearDown(() async {
      await broken.close(force: true);
      await healthy.close(force: true);
    });

    final api = ApiClient(
      baseUrl: 'http://127.0.0.1:${broken.port}',
      fallbacks: ['http://127.0.0.1:${healthy.port}'],
    );
    addTearDown(api.close);

    final result = await api.get('/api/health');
    expect((result as Map)['source'], 'fallback');
    expect(api.baseUrl, 'http://127.0.0.1:${healthy.port}');
  });

  test('не перемикається на 4xx — це відповідь живого сервера', () async {
    final auth = await _serve(401, {'error': {'code': 'unauthorized', 'message': 'потрібен вхід'}});
    final healthy = await _serve(200, {'ok': true});
    addTearDown(() async {
      await auth.close(force: true);
      await healthy.close(force: true);
    });

    final api = ApiClient(
      baseUrl: 'http://127.0.0.1:${auth.port}',
      fallbacks: ['http://127.0.0.1:${healthy.port}'],
    );
    addTearDown(api.close);

    await expectLater(api.get('/api/me'), throwsA(isA<ApiException>()));
    expect(api.baseUrl, 'http://127.0.0.1:${auth.port}');
  });

  test('ручне введення адреси скидає список резервів', () {
    final api = ApiClient(baseUrl: 'http://a', fallbacks: ['http://b', 'http://c', 'http://b']);
    expect(api.baseUrls, ['http://a', 'http://b', 'http://c']);
    api.baseUrl = 'http://manual';
    expect(api.baseUrls, ['http://manual']);
    expect(api.baseUrl, 'http://manual');
  });
}
