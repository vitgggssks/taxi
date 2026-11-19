// Автовиявлення адреси API: застосунок має отримувати свіжий список адрес із
// репозиторію, а будь-яка помилка мережі не повинна ламати запуск.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/api.dart';
import 'package:rukh_mobile/core/discovery.dart';

Future<HttpServer> _serve(int status, String body) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest request) async {
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
    request.response.write(body);
    await request.response.close();
  });
  return server;
}

void main() {
  test('читає список адрес і відкидає некоректні', () async {
    final server = await _serve(200, jsonEncode({
      'endpoints': [
        'https://a.trycloudflare.com',
        'http://192.168.0.10:3000',
        'ftp://nope',
        '   ',
      ],
    }));
    addTearDown(() => server.close(force: true));

    final endpoints = await Discovery(url: 'http://127.0.0.1:${server.port}/endpoint.json').endpoints();
    expect(endpoints, ['https://a.trycloudflare.com', 'http://192.168.0.10:3000']);
  });

  test('404 не ламає запуск — порожній список', () async {
    final server = await _serve(404, 'not found');
    addTearDown(() => server.close(force: true));
    expect(await Discovery(url: 'http://127.0.0.1:${server.port}/endpoint.json').endpoints(), isEmpty);
  });

  test('битий JSON не ламає запуск', () async {
    final server = await _serve(200, '{oops');
    addTearDown(() => server.close(force: true));
    expect(await Discovery(url: 'http://127.0.0.1:${server.port}/endpoint.json').endpoints(), isEmpty);
  });

  test('недоступний хост не ламає запуск', () async {
    final endpoints = await Discovery(
      url: 'http://127.0.0.1:1/endpoint.json',
      timeout: const Duration(milliseconds: 400),
    ).endpoints();
    expect(endpoints, isEmpty);
  });

  test('адреси з виявлення додаються до списку клієнта', () {
    final api = ApiClient(baseUrl: 'https://baked.example.com');
    addTearDown(api.close);
    api.setBaseUrls(['https://fresh.example.com', 'https://baked.example.com', 'https://fresh.example.com']);
    expect(api.baseUrls, ['https://fresh.example.com', 'https://baked.example.com']);
    expect(api.baseUrl, 'https://fresh.example.com');
  });
}
