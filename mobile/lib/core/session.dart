import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// Стан авторизації + налаштування зʼєднання, збережені між запусками.
class Session extends ChangeNotifier {
  Session({required this.api, required this.prefs});

  final ApiClient api;
  final SharedPreferences prefs;

  Map<String, dynamic>? user;
  bool ready = false;
  String? lastError;

  String get role => '${user?['role'] ?? 'passenger'}';
  String get displayName {
    final name = user?['name'];
    if (name is String && name.trim().isNotEmpty) return name;
    return _prettyPhone('${user?['phone'] ?? ''}');
  }

  String get phone => '${user?['phone'] ?? ''}';
  bool get isDriver => role == 'driver';
  bool get isStaff => role == 'admin' || role == 'dispatcher';

  static String _prettyPhone(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length == 12 && digits.startsWith('380')) {
      return '+380 ${digits.substring(3, 5)} ${digits.substring(5, 8)} ${digits.substring(8, 10)} ${digits.substring(10)}';
    }
    return raw;
  }

  Future<void> restore() async {
    final savedBase = prefs.getString('baseUrl');
    if (savedBase != null && savedBase.isNotEmpty) api.baseUrl = savedBase;
    final token = prefs.getString('token');
    if (token != null && token.isNotEmpty) {
      api.token = token;
      try {
        final me = await api.get('/api/me');
        user = me is Map ? Map<String, dynamic>.from(me) : null;
      } on ApiException catch (e) {
        lastError = e.message;
        api.token = null;
        await prefs.remove('token');
      }
    }
    ready = true;
    notifyListeners();
  }

  Future<void> signIn(String token, Map<String, dynamic> loggedUser) async {
    api.token = token;
    user = loggedUser;
    lastError = null;
    await prefs.setString('token', token);
    notifyListeners();
  }

  Future<void> refreshMe() async {
    if (api.token == null) return;
    try {
      final me = await api.get('/api/me');
      if (me is Map) {
        user = Map<String, dynamic>.from(me);
        notifyListeners();
      }
    } on ApiException {
      /* мережа — залишаємо попередні дані */
    }
  }

  Future<void> updateProfile({String? name, String? email}) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (email != null) body['email'] = email;
    final res = await api.patch('/api/me', body);
    if (res is Map && res['user'] is Map) {
      user = Map<String, dynamic>.from(res['user'] as Map);
      notifyListeners();
    }
  }

  Future<void> setBaseUrl(String url) async {
    api.baseUrl = url.trim();
    await prefs.setString('baseUrl', api.baseUrl);
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await api.post('/api/auth/logout');
    } on ApiException {
      /* сесія могла вже закінчитись */
    }
    api.token = null;
    user = null;
    await prefs.remove('token');
    notifyListeners();
  }
}
