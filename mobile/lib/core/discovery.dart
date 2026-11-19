// Автовиявлення адреси API.
//
// Проблема: публічна адреса демо-сервера (тунель) може змінитись або тимчасово
// впасти, а адреси вшиваються в APK під час збірки. Тому застосунок на старті
// читає `endpoint.json` із репозиторію (публічний raw-файл) — це стабільне
// посилання, яке не залежить від тунелю. Отримані адреси додаються до списку
// резервних, і `ApiClient` сам обирає живу.
//
// Порядок джерел адрес:
//   1) адреса, введена вручну (має найвищий пріоритет, зберігається в prefs);
//   2) `endpoint.json` (актуальний список від сервера);
//   3) адреси, вшиті в APK під час збірки (працюють навіть без інтернету до GitHub).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Публічний файл із переліком адрес API.
const String kDiscoveryUrl = String.fromEnvironment(
  'API_DISCOVERY_URL',
  defaultValue: 'https://raw.githubusercontent.com/vitgggssks/taxi/main/endpoint.json',
);

class Discovery {
  Discovery({this.url = kDiscoveryUrl, this.timeout = const Duration(seconds: 6)});

  final String url;
  final Duration timeout;

  /// Повертає список адрес або порожній список, якщо файл недоступний.
  /// Ніколи не кидає: виявлення адреси не має ламати запуск застосунку.
  Future<List<String>> endpoints() async {
    final client = HttpClient()..connectionTimeout = timeout;
    try {
      final request = await client.getUrl(Uri.parse(url)).timeout(timeout);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final response = await request.close().timeout(timeout);
      if (response.statusCode != 200) return const <String>[];
      final body = await utf8.decoder.bind(response).join().timeout(timeout);
      final decoded = jsonDecode(body);
      if (decoded is! Map) return const <String>[];
      final list = decoded['endpoints'];
      if (list is! List) return const <String>[];
      return list
          .map((e) => '$e'.trim())
          .where((e) => e.startsWith('http://') || e.startsWith('https://'))
          .toList();
    } catch (_) {
      return const <String>[];
    } finally {
      client.close(force: true);
    }
  }
}
