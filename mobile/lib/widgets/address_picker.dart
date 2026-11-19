import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../theme.dart';

/// Повноекранний вибір адреси: пошук по індексу міста + збережені адреси.
Future<GeoAddress?> pickAddress(
  BuildContext context, {
  required ApiClient api,
  required String cityId,
  String title = 'Адреса',
}) {
  return showModalBottomSheet<GeoAddress>(
    context: context,
    isScrollControlled: true,
    backgroundColor: RukhTheme.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (context) => _AddressSheet(api: api, cityId: cityId, title: title),
  );
}

class _AddressSheet extends StatefulWidget {
  const _AddressSheet({required this.api, required this.cityId, required this.title});

  final ApiClient api;
  final String cityId;
  final String title;

  @override
  State<_AddressSheet> createState() => _AddressSheetState();
}

class _AddressSheetState extends State<_AddressSheet> {
  final _controller = TextEditingController();
  List<GeoAddress> _results = [];
  List<Map<String, dynamic>> _saved = [];
  bool _busy = false;
  String? _error;
  int _requestId = 0;

  @override
  void initState() {
    super.initState();
    _loadSaved();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadSaved() async {
    try {
      final res = await widget.api.get('/api/me/addresses');
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      if (mounted) setState(() => _saved = items);
    } on ApiException {
      /* немає збережених адрес — не критично */
    }
  }

  Future<void> _search(String term) async {
    final query = term.trim();
    final id = ++_requestId;
    if (query.length < 2) {
      setState(() {
        _results = [];
        _error = null;
      });
      return;
    }
    setState(() => _busy = true);
    try {
      final res = await widget.api.get('/api/geo/search', {'cityId': widget.cityId, 'q': query});
      if (!mounted || id != _requestId) return;
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      setState(() {
        _results = items.map(GeoAddress.fromJson).toList();
        _error = items.isEmpty ? 'Нічого не знайдено у цьому місті' : null;
      });
    } on ApiException catch (e) {
      if (!mounted || id != _requestId) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.72,
        child: Column(
          children: [
            const SizedBox(height: 12),
            Container(
              width: 44,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: TextField(
                controller: _controller,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: (value) {
                  _search(value);
                },
                decoration: InputDecoration(
                  hintText: widget.title,
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _busy
                      ? const Padding(
                          padding: EdgeInsets.all(14),
                          child: SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        )
                      : null,
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(_error!, style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(8, 8, 8, 24),
                children: [
                  if (_results.isNotEmpty) ...[
                    const _ListHeader('РЕЗУЛЬТАТИ ПОШУКУ'),
                    ..._results.map(
                      (a) => ListTile(
                        leading: const Icon(Icons.place_outlined, color: RukhTheme.accent),
                        title: Text(a.label),
                        subtitle: Text('${a.lat.toStringAsFixed(5)}, ${a.lng.toStringAsFixed(5)}',
                            style: const TextStyle(fontSize: 11)),
                        onTap: () => Navigator.pop(context, a),
                      ),
                    ),
                  ],
                  if (_controller.text.trim().isEmpty) ...[
                    if (_saved.isNotEmpty) ...[
                      const _ListHeader('МОЇ АДРЕСИ'),
                      ..._saved.map(
                        (a) => ListTile(
                          leading: const Icon(Icons.bookmark_border, color: RukhTheme.muted),
                          title: Text('${a['label']}'),
                          subtitle: Text('${a['address']}', style: const TextStyle(fontSize: 12)),
                          onTap: () => Navigator.pop(
                            context,
                            GeoAddress.fromJson(a),
                          ),
                        ),
                      ),
                    ] else
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Text(
                          'Почніть вводити вулицю — пошук працює по індексу адрес обраного міста.',
                          style: TextStyle(color: RukhTheme.muted, fontSize: 12),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ListHeader extends StatelessWidget {
  const _ListHeader(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
      child: Text(
        text,
        style: const TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1.2, fontWeight: FontWeight.w700),
      ),
    );
  }
}
