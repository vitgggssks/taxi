/// Форматування грошей, часу та людські підписи статусів.
String money(int cents, {String currency = '₴'}) {
  final sign = cents < 0 ? '−' : '';
  final abs = cents.abs();
  final hryvnia = abs ~/ 100;
  final kop = abs % 100;
  final body = kop == 0 ? '$hryvnia' : '$hryvnia.${kop.toString().padLeft(2, '0')}';
  return '$sign$body $currency';
}

String distanceText(int meters) {
  if (meters < 1000) return '$meters м';
  return '${(meters / 1000).toStringAsFixed(1)} км';
}

String durationText(int seconds) {
  final m = (seconds / 60).round();
  if (m < 60) return '$m хв';
  final h = m ~/ 60;
  return '$h год ${m % 60} хв';
}

String countdown(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
}

String dateTimeText(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  final parsed = DateTime.tryParse(iso.replaceFirst(' ', 'T'));
  if (parsed == null) return iso;
  final local = parsed.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(local.day)}.${two(local.month)}.${local.year} ${two(local.hour)}:${two(local.minute)}';
}

String statusLabel(String status) => switch (status) {
      'searching' => 'Пошук водія',
      'offered' => 'Пропозиція надіслана',
      'no_drivers' => 'Немає вільних водіїв',
      'assigned' => 'Водія призначено',
      'driver_arriving' => 'Авто прибуває',
      'waiting' => 'Очікування пасажира',
      'in_progress' => 'У дорозі',
      'completed' => 'Завершено',
      'canceled' => 'Скасовано',
      'expired' => 'Термін минув',
      _ => status,
    };

String paymentLabel(String method) => switch (method) {
      'cash' => 'Готівка',
      'card' => 'Картка',
      'apple_pay' => 'Apple Pay',
      'google_pay' => 'Google Pay',
      'wallet' => 'Баланс',
      'corporate' => 'Корпоративний',
      _ => method,
    };

String serviceLabel(String kind) => switch (kind) {
      'delivery' => 'Доставка',
      'sober' => 'Тверезий водій',
      'intercity' => 'Міжміське',
      _ => 'Поїздка',
    };

const List<String> orderTimeline = [
  'searching',
  'assigned',
  'driver_arriving',
  'in_progress',
  'completed',
];
