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
  final _passengerScaffold = GlobalKey<ScaffoldState>();

  @override
  Widget build(BuildContext context) {
    final isDriver = widget.session.isDriver;
    if (!isDriver) return _passengerShell();
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
  Widget _passengerShell() {
    void open(Widget screen) {
      Navigator.of(context).pop();
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
    }
    Widget menuItem(IconData icon, String title, VoidCallback onTap) => ListTile(
      leading: Icon(icon, color: const Color(0xFFC5D2D9), size: 27),
      title: Text(title, style: const TextStyle(color: Color(0xFF263238), fontSize: 20)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20), minLeadingWidth: 24,
      onTap: onTap,
    );
    return Scaffold(
      key: _passengerScaffold,
      drawer: Drawer(
        backgroundColor: Colors.white,
        child: SafeArea(child: Column(children: [
          InkWell(onTap: () => open(ProfileScreen(api: widget.api, session: widget.session)),
            child: Padding(padding: const EdgeInsets.all(20), child: Row(children: [
              const CircleAvatar(radius: 27, backgroundColor: Color(0xFFF0F5F8), child: Icon(Icons.person_outline, color: Color(0xFFBFCED5))),
              const SizedBox(width: 18),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(widget.session.displayName, style: const TextStyle(fontSize: 21, color: Color(0xFF263238))),
                Text(widget.session.phone, style: const TextStyle(fontSize: 14, color: Color(0xFF7B8991))),
              ])),
            ]))),
          const Divider(height: 1),
          Container(color: const Color(0xFFD4F5DE), child: menuItem(Icons.add, 'Нове замовлення', () => Navigator.of(context).pop())),
          const Divider(height: 1),
          Expanded(child: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
            menuItem(Icons.bookmark_border, 'Мої поїздки', () => open(HistoryScreen(api: widget.api, session: widget.session))),
            menuItem(Icons.star_border, 'Мої адреси', () => open(ProfileScreen(api: widget.api, session: widget.session))),
            menuItem(Icons.credit_card, 'Оплата і промокоди', () => open(WalletScreen(api: widget.api, session: widget.session))),
            menuItem(Icons.person_outline, 'Профіль і підтримка', () => open(ProfileScreen(api: widget.api, session: widget.session))),
          ])),
        ])),
      ),
      body: BookingScreen(api: widget.api, session: widget.session, onMenu: () => _passengerScaffold.currentState?.openDrawer()),
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
