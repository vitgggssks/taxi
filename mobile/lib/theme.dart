import 'package:flutter/material.dart';

import 'core/format.dart';

/// Палітра в тонах оригінального OnTaxi: жовтий #FFD000 + чорний на білому.
/// (Основний бренд-колір OnTaxi зчитано з їхнього сайту: #ffd000 / #ffc40d.)
class RukhTheme {
  /// Бренд-жовтий OnTaxi.
  static const Color accent = Color(0xFFFFD000);

  /// Світло-жовта підкладка (бейджі, виділення).
  static const Color accentSoft = Color(0xFFFFF4C2);

  /// Основний текст / чорні елементи.
  static const Color ink = Color(0xFF14171A);

  /// Картки, поля, панелі.
  static const Color surface = Color(0xFFFFFFFF);

  /// Другорядний фон (поля вводу, чипи, смуги).
  static const Color surfaceAlt = Color(0xFFF1F3F5);

  /// Фон екрана.
  static const Color background = Color(0xFFF6F7F9);

  static const Color muted = Color(0xFF66707A);
  static const Color danger = Color(0xFFC9302C);
  static const Color warning = Color(0xFFF59E0B);
  static const Color success = Color(0xFF12B76A);

  /// Ледь помітна рамка карток/списків.
  static const Color border = Color(0x14000000);

  /// Тло основних кнопок із жовтим акцентом.
  static const Color onAccent = ink;

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(seedColor: accent, brightness: Brightness.light).copyWith(
      primary: accent,
      onPrimary: ink,
      primaryContainer: accentSoft,
      onPrimaryContainer: ink,
      surface: surface,
      onSurface: ink,
      secondary: warning,
      error: danger,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      canvasColor: background,
      cardColor: surface,
      splashFactory: InkSparkle.splashFactory,
      appBarTheme: const AppBarTheme(
        backgroundColor: background,
        foregroundColor: ink,
        surfaceTintColor: Colors.transparent,
        centerTitle: false,
        elevation: 0,
        titleTextStyle: TextStyle(color: ink, fontSize: 20, fontWeight: FontWeight.w800),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: ink,
          minimumSize: const Size.fromHeight(52),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: ink),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: ink,
          side: const BorderSide(color: border),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surfaceAlt,
        hintStyle: const TextStyle(color: muted),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        margin: EdgeInsets.zero,
      ),
      iconTheme: const IconThemeData(color: ink),
      progressIndicatorTheme: const ProgressIndicatorThemeData(color: ink),
      snackBarTheme: const SnackBarThemeData(
        backgroundColor: ink,
        contentTextStyle: TextStyle(color: Colors.white),
        behavior: SnackBarBehavior.floating,
      ),
      dividerTheme: const DividerThemeData(color: border, space: 1),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
      ),
      dialogTheme: const DialogThemeData(backgroundColor: surface, surfaceTintColor: Colors.transparent),
      listTileTheme: const ListTileThemeData(iconColor: ink, textColor: ink),
    );
  }
}

/// Кольори статусів — у світлій темі потрібні темніші відтінки, ніж «чистий»
/// акцент, інакше текст чипа не читається на білому.
Color statusColor(String status) => switch (status) {
      'searching' || 'offered' => const Color(0xFF8F5B00),
      'no_drivers' || 'canceled' || 'expired' => RukhTheme.danger,
      'completed' => const Color(0xFF0B7A48),
      _ => const Color(0xFF1F6FEB),
    };

/// Монограма бренду (без зовнішніх ассетів) — жовтий квадрат із чорною «Р».
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 40, this.label = 'Р'});

  final double size;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: RukhTheme.accent,
        borderRadius: BorderRadius.circular(size * 0.28),
      ),
      alignment: Alignment.center,
      child: Text(
        label,
        style: TextStyle(
          color: RukhTheme.ink,
          fontWeight: FontWeight.w800,
          fontSize: size * 0.5,
        ),
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        statusLabel(status),
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700),
      ),
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.child, this.title, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final String? title;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: RukhTheme.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: RukhTheme.border),
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 12, offset: const Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) ...[
            Text(
              title!.toUpperCase(),
              style: const TextStyle(
                color: RukhTheme.muted,
                fontSize: 11,
                letterSpacing: 1.1,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 10),
          ],
          child,
        ],
      ),
    );
  }
}

class ErrorBox extends StatelessWidget {
  const ErrorBox({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RukhTheme.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RukhTheme.danger.withValues(alpha: 0.30)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: RukhTheme.danger, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(message, style: const TextStyle(color: RukhTheme.danger))),
        ],
      ),
    );
  }
}
