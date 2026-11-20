import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/discovery.dart';

/// Перевіряє, що застосунок обирає НАЙНОВІШИЙ список адрес серед кількох джерел
/// (raw/CDN кешують файл по-різному — застаріла відповідь не має перемагати).
void main() {
  late HttpServer server;

  setUp(() async => server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
  tearDown(() async => server.close(force: true));

  String url(String path) => 'http://127.0.0.1:${server.port}$path';

  void serve(Future<void> Function(HttpRequest) handler) {
    server.listen((request) async {
      await handler(request);
    });
  }

  Future<void> json(HttpRequest request, Object body) async {
    request.response.headers.contentType = ContentType.json;
    request.response.write(jsonEncode(body));
    await request.response.close();
  }

  test('обирає свіжий список, а не закешований старий', () async {
    serve((request) async {
      if (request.uri.path == '/stale') {
        return json(request, {
          'updatedAt': '2026-01-01T00:00:00.000Z',
          'endpoints': ['https://dead.example.com'],
        });
      }
      if (request.uri.path == '/fresh') {
        return json(request, {
          'updatedAt': '2026-11-20T09:07:00.000Z',
          'endpoints': ['https://live.example.com'],
        });
      }
      request.response.statusCode = 404;
      await request.response.close();
    });

    final found = await Discovery(
      urls: [url('/stale'), url('/fresh')],
      timeout: const Duration(seconds: 3),
    ).endpoints();

    expect(found, ['https://live.example.com']);
  });

  test('розбирає відповідь GitHub Contents API (base64)', () async {
    final payload = jsonEncode({
      'updatedAt': '2026-11-20T10:00:00.000Z',
      'endpoints': ['https://a.example.com', 'https://b.example.com'],
    });
    serve((request) async {
      await json(request, {
        'encoding': 'base64',
        'content': base64Encode(utf8.encode(payload)),
      });
    });

    final found = await Discovery(
      urls: [url('/contents/endpoint.json')],
      timeout: const Duration(seconds: 3),
    ).endpoints();

    expect(found, ['https://a.example.com', 'https://b.example.com']);
  });

  test('усі джерела недоступні — порожній список без винятку', () async {
    serve((request) async {
      request.response.statusCode = 500;
      await request.response.close();
    });

    final found = await Discovery(
      urls: [url('/a'), url('/b')],
      timeout: const Duration(seconds: 2),
    ).endpoints();

    expect(found, isEmpty);
  });
}
