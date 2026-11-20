// Автовиявлення адреси API.
//
// Проблема: публічна адреса демо-сервера (тунель) може змінитись або тимчасово
// впасти, а адреси вшиваються в APK під час збірки. Тому застосунок на старті
// читає `endpoint.json` із репозиторію — це стабільне посилання, яке не залежить
// від тунелю. Отримані адреси додаються до списку резервних, і `ApiClient` сам
// обирає живу.
//
// Джерела читаються ПАРАЛЕЛЬНО, бо кожен із них кешує файл по-своєму:
//   1) api.github.com/contents — завжди свіжий (ліміт 60 запитів/год на IP);
//   2) raw.githubusercontent.com — CDN кешує до ~5 хв;
//   3) cdn.jsdelivr.net — кеш гілки може триматися годинами (резерв).
// Перемагає відповідь із найновішим `updatedAt`, у якій є хоча б одна адреса.
//
// Порядок пріоритету адрес у застосунку:
//   1) адреса, введена вручну (зберігається в prefs);
//   2) свіжий список із `endpoint.json`;
//   3) адреси, вшиті в APK під час збірки (працюють навіть без доступу до GitHub).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Публічні джерела переліку адрес API (перевіряються паралельно).
const List<String> kDiscoverySources = <String>[
  'https://api.github.com/repos/vitgggssks/taxi/contents/endpoint.json',
  'https://raw.githubusercontent.com/vitgggssks/taxi/main/endpoint.json',
  'https://cdn.jsdelivr.net/gh/vitgggssks/taxi@main/endpoint.json',
];

/// Основне джерело (для сумісності й для діагностики в UI).
const String kDiscoveryUrl = String.fromEnvironment(
  'API_DISCOVERY_URL',
  defaultValue: 'https://api.github.com/repos/vitgggssks/taxi/contents/endpoint.json',
);

class _Snapshot {
  _Snapshot(this.updatedAt, this.endpoints);
  final DateTime updatedAt;
  final List<String> endpoints;
}

class Discovery {
  Discovery({String? url, List<String>? urls, this.timeout = const Duration(seconds: 6)})
      : urls = urls ?? <String>[if (url != null) url else kDiscoveryUrl, ..._extraSources(url)];

  final List<String> urls;
  final Duration timeout;

  /// Якщо задано конкретну адресу — читаємо лише її (тести, ручний override).
  static List<String> _extraSources(String? explicit) {
    if (explicit != null) return const <String>[];
    return kDiscoverySources.where((u) => u != kDiscoveryUrl).toList();
  }

  /// Повертає список адрес або порожній список, якщо жодне джерело недоступне.
  /// Ніколи не кидає: виявлення адреси не має ламати запуск застосунку.
  Future<List<String>> endpoints() async {
    final snapshots = await Future.wait(urls.map(_fetch).toList());
    final valid = snapshots.whereType<_Snapshot>().where((s) => s.endpoints.isNotEmpty).toList();
    if (valid.isEmpty) return const <String>[];
    valid.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return valid.first.endpoints;
  }

  Future<_Snapshot?> _fetch(String url) async {
    final client = HttpClient()..connectionTimeout = timeout;
    try {
      // cache-buster нешкідливий для CDN, але змушує віддати свіжий файл там,
      // де кеш ключується повним URL.
      final uri = Uri.parse(url).replace(queryParameters: <String, String>{
        ...Uri.parse(url).queryParameters,
        'v': '${DateTime.now().millisecondsSinceEpoch}',
      });
      final request = await client.getUrl(uri).timeout(timeout);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      request.headers.set(HttpHeaders.userAgentHeader, 'rukh-demo-app');
      final response = await request.close().timeout(timeout);
      if (response.statusCode != 200) return null;
      final body = await utf8.decoder.bind(response).join().timeout(timeout);
      return _parse(body);
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  /// Розбирає або `endpoint.json`, або відповідь GitHub Contents API
  /// (`{"content": "<base64>", "encoding": "base64"}`).
  _Snapshot? _parse(String body) {
    Object? decoded;
    try {
      decoded = jsonDecode(body);
    } catch (_) {
      return null;
    }
    if (decoded is! Map) return null;
    var payload = decoded;
    if (decoded['content'] is String && decoded['encoding'] == 'base64') {
      try {
        final inner = utf8.decode(base64Decode('${decoded['content']}'.replaceAll('\n', '')));
        final parsed = jsonDecode(inner);
        if (parsed is Map) payload = parsed;
      } catch (_) {
        return null;
      }
    }
    final list = payload['endpoints'];
    if (list is! List) return null;
    final endpoints = list
        .map((e) => '$e'.trim())
        .where((e) => e.startsWith('http://') || e.startsWith('https://'))
        .toList();
    final raw = payload['updatedAt'];
    final updatedAt = raw is String ? (DateTime.tryParse(raw) ?? DateTime.fromMillisecondsSinceEpoch(0)) : DateTime.fromMillisecondsSinceEpoch(0);
    return _Snapshot(updatedAt, endpoints);
  }
}
