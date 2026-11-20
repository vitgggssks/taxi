// Старт застосунку не має чекати мережу: UI показується одразу, токен
// перевіряється у фоні (раніше main() чекав restore() до першого кадру).
import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/core/api.dart';
import 'package:rukh_mobile/core/session.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('ready стає true одразу, навіть якщо сервер недоступний', () async {
    SharedPreferences.setMockInitialValues({'token': 'abc'});
    final prefs = await SharedPreferences.getInstance();
    final api = ApiClient(baseUrl: 'http://127.0.0.1:1')
      ..requestTimeout = const Duration(milliseconds: 300);
    addTearDown(api.close);
    final session = Session(api: api, prefs: prefs);

    final pending = session.restore();
    expect(session.ready, isTrue, reason: 'UI не має чекати мережу');
    await pending;

    expect(session.ready, isTrue);
    // мережева помилка не стирає токен — відновимо звʼязок і зайдемо далі
    expect(api.token, 'abc');
    expect(session.user, isNull);
  });

  test('без збереженого токена одразу готово і без користувача', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final api = ApiClient(baseUrl: 'http://127.0.0.1:1');
    addTearDown(api.close);
    final session = Session(api: api, prefs: prefs);
    await session.restore();
    expect(session.ready, isTrue);
    expect(session.user, isNull);
  });
}
