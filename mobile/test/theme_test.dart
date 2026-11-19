// Палітра в тонах оригінального OnTaxi: жовтий #FFD000 + чорний на білому.
// Тест фіксує бренд-кольори й перевіряє контраст тексту (WCAG AA ≥ 4.5:1),
// щоб світла тема не «з'їла» читабельність.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/theme.dart';

double _luminance(Color c) {
  double channel(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double contrast(Color a, Color b) {
  final l1 = _luminance(a), l2 = _luminance(b);
  final hi = math.max(l1, l2), lo = math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  test('бренд-жовтий збігається з OnTaxi (#FFD000)', () {
    expect(RukhTheme.accent, const Color(0xFFFFD000));
    expect(RukhTheme.surface, const Color(0xFFFFFFFF));
    expect(RukhTheme.onAccent, RukhTheme.ink);
  });

  test('тема світла, а не темна', () {
    final theme = RukhTheme.light();
    expect(theme.colorScheme.brightness, Brightness.light);
    expect(theme.scaffoldBackgroundColor, RukhTheme.background);
    expect(theme.appBarTheme.backgroundColor, RukhTheme.background);
    expect(theme.filledButtonTheme.style!.backgroundColor!.resolve({}), RukhTheme.accent);
  });

  test('текст читається: ink на білому, ink на жовтому, muted на білому', () {
    expect(contrast(RukhTheme.ink, RukhTheme.surface), greaterThan(12));
    expect(contrast(RukhTheme.ink, RukhTheme.accent), greaterThan(9));
    expect(contrast(RukhTheme.muted, RukhTheme.surface), greaterThan(4.0));
  });

  test('кольори статусів читаються на білому', () {
    for (final status in ['searching', 'offered', 'completed', 'canceled', 'assigned']) {
      expect(contrast(statusColor(status), RukhTheme.surface), greaterThan(4.0), reason: status);
    }
  });
}
