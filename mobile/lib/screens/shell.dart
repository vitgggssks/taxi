import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../theme.dart';
import 'booking_screen.dart';
import 'driver_screen.dart';
import 'history_screen.dart';
import 'profile_screen.dart';
import 'wallet_screen.dart';

/// Нижня навігація. Склад вкладок залежить від ролі користувача.
class Shell extends StatefulWidget {
  const Shell({super.key, required this.api, required this.session});

  final ApiClient api;
  final Session session;

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final isDriver = widget.session.isDriver;
    final tabs = <Widget>[
      isDriver ? DriverScreen(api: widget.api, session: widget.session) : BookingScreen(api: widget.api, session: widget.session),
      HistoryScreen(api: widget.api, session: widget.session),
      WalletScreen(api: widget.api, session: widget.session),
      ProfileScreen(api: widget.api, session: widget.session),
    ];
    final items = <BottomNavigationBarItem>[
      BottomNavigationBarItem(
        icon: Icon(isDriver ? Icons.local_taxi_outlined : Icons.local_taxi_outlined),
        activeIcon: Icon(isDriver ? Icons.local_taxi : Icons.local_taxi),
        label: isDriver ? 'Робота' : 'Поїздка',
      ),
      const BottomNavigationBarItem(icon: Icon(Icons.receipt_long_outlined), activeIcon: Icon(Icons.receipt_long), label: 'Історія'),
      const BottomNavigationBarItem(icon: Icon(Icons.account_balance_wallet_outlined), activeIcon: Icon(Icons.account_balance_wallet), label: 'Гаманець'),
      const BottomNavigationBarItem(icon: Icon(Icons.person_outline), activeIcon: Icon(Icons.person), label: 'Профіль'),
    ];

    return Scaffold(
      body: IndexedStack(index: _index, children: tabs),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: RukhTheme.surface,
          border: const Border(top: BorderSide(color: RukhTheme.border)),
        ),
        child: BottomNavigationBar(
          currentIndex: _index,
          onTap: (i) => setState(() => _index = i),
          type: BottomNavigationBarType.fixed,
          backgroundColor: Colors.transparent,
          elevation: 0,
          selectedItemColor: RukhTheme.ink,
          unselectedItemColor: RukhTheme.muted,
          selectedFontSize: 11,
          unselectedFontSize: 11,
          items: items,
        ),
      ),
    );
  }
}

/// Спільний хедер екранів.
class RukhAppBar extends StatelessWidget implements PreferredSizeWidget {
  const RukhAppBar({super.key, required this.title, this.subtitle, this.actions, this.bottom});

  final String title;
  final String? subtitle;
  final List<Widget>? actions;
  final PreferredSizeWidget? bottom;

  @override
  Size get preferredSize => Size.fromHeight(kToolbarHeight + (bottom?.preferredSize.height ?? 0));

  @override
  Widget build(BuildContext context) {
    return AppBar(
      titleSpacing: 16,
      title: Row(
        children: [
          const BrandMark(size: 34),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              if (subtitle != null)
                Text(subtitle!, style: const TextStyle(color: RukhTheme.muted, fontSize: 11)),
            ],
          ),
        ],
      ),
      actions: actions,
      bottom: bottom,
    );
  }
}

void showError(BuildContext context, Object error) {
  final message = error is ApiException ? error.message : '$error';
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message), backgroundColor: RukhTheme.surfaceAlt),
  );
}
