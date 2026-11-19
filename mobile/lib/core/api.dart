import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Помилка бізнес-рівня, яку сервер повертає у `{ error: { code, message } }`.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.details]);

  final int status;
  final String code;
  final String message;
  final Object? details;

  bool get isAuth => status == 401 || status == 403;

  @override
  String toString() => message;
}

/// Тонкий типізований клієнт REST + WebSocket до RUKH API.
class ApiClient {
  ApiClient({required this.baseUrl});

  String baseUrl;
  String? token;

  final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 12);
  bool _closed = false;

  Uri _uri(String path, [Map<String, String>? query]) {
    final trimmed = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    final base = Uri.parse(trimmed);
    final merged = <String, String>{...base.queryParameters, ...?query};
    return base.replace(path: path, queryParameters: merged.isEmpty ? null : merged);
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) => send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body]) => send('POST', path, body: body);
  Future<dynamic> patch(String path, [Object? body]) => send('PATCH', path, body: body);
  Future<dynamic> delete(String path) => send('DELETE', path);

  Future<dynamic> send(String method, String path, {Map<String, String>? query, Object? body}) async {
    if (_closed) throw ApiException(0, 'client_closed', 'Клієнт закрито');
    final HttpClientRequest req;
    try {
      req = await _http.openUrl(method, _uri(path, query));
    } on SocketException catch (e) {
      throw ApiException(0, 'network', 'Немає звʼязку з сервером: ${e.message}');
    }
    req.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final t = token;
    if (t != null && t.isNotEmpty) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $t');
    if (body != null) {
      final bytes = utf8.encode(jsonEncode(body));
      req.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
      req.contentLength = bytes.length;
      req.add(bytes);
    }
    final HttpClientResponse res;
    try {
      res = await req.close().timeout(const Duration(seconds: 25));
    } on SocketException catch (e) {
      throw ApiException(0, 'network', 'Немає звʼязку з сервером: ${e.message}');
    } on TimeoutException {
      throw ApiException(0, 'timeout', 'Сервер не відповів вчасно');
    }
    final text = await utf8.decoder.bind(res).join();
    dynamic decoded;
    if (text.isNotEmpty) {
      try {
        decoded = jsonDecode(text);
      } on FormatException {
        decoded = null;
      }
    }
    if (res.statusCode >= 400) {
      String code = 'http_${res.statusCode}';
      String message = 'Помилка ${res.statusCode}';
      Object? details;
      if (decoded is Map && decoded['error'] is Map) {
        final err = decoded['error'] as Map;
        code = '${err['code'] ?? code}';
        message = '${err['message'] ?? message}';
        details = err['details'];
      }
      throw ApiException(res.statusCode, code, message, details);
    }
    return decoded;
  }

  Uri wsUri(String token) {
    final base = Uri.parse(baseUrl.trim().replaceAll(RegExp(r'/+$'), ''));
    return base.replace(
      scheme: base.scheme == 'https' ? 'wss' : 'ws',
      path: '/ws',
      queryParameters: {'token': token},
    );
  }

  void close() {
    _closed = true;
    _http.close(force: true);
  }
}
