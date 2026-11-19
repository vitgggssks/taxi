import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/api.dart';
import 'core/session.dart';
import 'screens/login_screen.dart';
import 'screens/shell.dart';
import 'theme.dart';

/// Адреса API за замовчуванням: 10.0.2.2 — хост-машина з емулятора Android.
/// Змінюється у застосунку (Профіль → Сервер) або прапорцем збірки
/// `--dart-define=API_BASE_URL=https://api.example.com`.
const String kDefaultBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3000',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final api = ApiClient(baseUrl: prefs.getString('baseUrl') ?? kDefaultBaseUrl);
  final session = Session(api: api, prefs: prefs);
  await session.restore();
  runApp(RukhApp(api: api, session: session));
}

class RukhApp extends StatelessWidget {
  const RukhApp({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'РУХ',
      debugShowCheckedModeBanner: false,
      theme: RukhTheme.dark(),
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        minScaleFactor: 0.9,
        maxScaleFactor: 1.3,
        child: child ?? const SizedBox.shrink(),
      ),
      home: AnimatedBuilder(
        animation: session,
        builder: (context, _) {
          if (!session.ready) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          if (session.user == null) {
            return LoginScreen(session: session);
          }
          return Shell(api: api, session: session);
        },
      ),
    );
  }
}
