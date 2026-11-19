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
  ApiClient({required String baseUrl, List<String> fallbacks = const <String>[]}) {
    final seen = <String>{};
    baseUrls = <String>[
      for (final url in <String>[baseUrl, ...fallbacks])
        if (url.trim().isNotEmpty && seen.add(url.trim())) url.trim(),
    ];
  }

  /// Список адрес API: перша — основна, решта — резервні. Якщо основна не
  /// відповідає (мережа/5xx), клієнт автоматично перемикається на наступну.
  late List<String> baseUrls;

  int _active = 0;

  String get baseUrl => baseUrls[_active];

  set baseUrl(String value) {
    baseUrls = <String>[value];
    _active = 0;
  }

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
    ApiException? lastError;
    final attempts = baseUrls.length;
    for (var attempt = 0; attempt < attempts; attempt++) {
      try {
        return await _sendOnce(method, path, query: query, body: body);
      } on ApiException catch (e) {
        lastError = e;
        // фолбек має сенс лише для мережевих збоїв і 5xx (502/503/530 тощо)
        final retryable = e.status == 0 || e.status >= 500;
        if (!retryable || attempt == attempts - 1) rethrow;
        _active = (_active + 1) % attempts;
      }
    }
    throw lastError ?? ApiException(0, 'network', 'Немає звʼязку з сервером');
  }

  Future<dynamic> _sendOnce(String method, String path, {Map<String, String>? query, Object? body}) async {
    final HttpClientRequest req;
    try {
      req = await _http.openUrl(method, _uri(path, query));
    } on SocketException catch (e) {
      throw ApiException(0, 'network', 'Немає звʼязку з сервером: ${e.message}');
    }
    req.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final t = token;
    if (t != null && t.isNotEmpty) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $t');
    // POST/PATCH/PUT завжди йдуть із JSON-тілом: проксі (Cloudflare тощо)
    // додають власний content-type до запиту без тіла, і сервер відповідає 415.
    final needsBody = body != null || method == 'POST' || method == 'PATCH' || method == 'PUT';
    if (needsBody) {
      final bytes = utf8.encode(jsonEncode(body ?? const <String, dynamic>{}));
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
