import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/session.dart';
import '../theme.dart';
import '../widgets/address_picker.dart';
import '../widgets/osm_map.dart';
import 'order_screen.dart';
import 'shell.dart';

/// Екран замовлення поїздки: адреси, клас авто, опції, оплата, плюс/мінус.
class BookingScreen extends StatefulWidget {
  const BookingScreen({super.key, required this.api, required this.session, this.onMenu});

  final ApiClient api;
  final Session session;
  final VoidCallback? onMenu;

  @override
  State<BookingScreen> createState() => _BookingScreenState();
}

class _BookingScreenState extends State<BookingScreen> {
  bool _details = false;
  bool _loading = true;
  String? _error;
  String? _quoteError;

  City? _city;
  List<CarClass> _classes = [];
  List<OrderOption> _options = [];
  int _maxStops = 5;

  String _serviceKind = 'ride';
  final List<GeoAddress?> _points = <GeoAddress?>[null, null];
  final Set<String> _selectedOptions = <String>{};
  String _payment = 'cash';
  int _plusMinusCents = 0;
  bool _scheduled = false;
  DateTime? _scheduledAt;

  final _promoCtrl = TextEditingController();
  final _commentCtrl = TextEditingController();
  final _senderNameCtrl = TextEditingController();
  final _senderPhoneCtrl = TextEditingController();
  final _recipientNameCtrl = TextEditingController();
  final _recipientPhoneCtrl = TextEditingController();
  final _weightCtrl = TextEditingController(text: '1');

  String? _promoMessage;
  bool _promoOk = false;

  Map<String, Quote> _quotes = <String, Quote>{};
  String? _selectedClassId;
  bool _quoting = false;
  Timer? _debounce;

  Order? _activeOrder;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _promoCtrl.dispose();
    _commentCtrl.dispose();
    _senderNameCtrl.dispose();
    _senderPhoneCtrl.dispose();
    _recipientNameCtrl.dispose();
    _recipientPhoneCtrl.dispose();
    _weightCtrl.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await widget.api.get('/api/cities');
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      final cities = items.map(City.fromJson).toList();
      if (cities.isEmpty) throw ApiException(404, 'no_cities', 'Немає доступних міст');
      _city = cities.first;
      await _loadCatalog();
      await _loadActiveOrder();
    } on ApiException catch (e) {
      _error = e.message;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadCatalog() async {
    final city = _city;
    if (city == null) return;
    final kind = _serviceKind == 'ride' ? 'ride' : (_serviceKind == 'delivery' ? 'delivery' : 'service');
    final res = await widget.api.get('/api/catalog', {'cityId': city.id, 'classKind': kind});
    final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
    final classes = asMapList(map['classes']).map(CarClass.fromJson).toList();
    setState(() {
      _classes = classes;
      _options = asMapList(map['options']).map(OrderOption.fromJson).toList();
      _maxStops = map['maxStops'] is num ? (map['maxStops'] as num).toInt() : 5;
      _selectedOptions.removeWhere((code) => !_options.any((o) => o.code == code));
      if (classes.isNotEmpty && !classes.any((c) => c.id == _selectedClassId)) {
        _selectedClassId = classes.first.id;
      }
      _quotes = <String, Quote>{};
    });
    await _refreshQuotes();
  }

  Future<void> _loadActiveOrder() async {
    try {
      final res = await widget.api.get('/api/orders', {
        'status': 'searching,offered,no_drivers,assigned,driver_arriving,waiting,in_progress',
        'limit': '1',
      });
      final items = res is Map ? asMapList(res['items']) : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() => _activeOrder = items.isEmpty ? null : Order.fromJson(items.first));
    } on ApiException {
      /* не блокуємо екран замовлення */
    }
  }

  List<Map<String, dynamic>> get _validPoints =>
      _points.whereType<GeoAddress>().map((p) => p.toPointJson()).toList();

  bool get _routeReady => _validPoints.length >= 2 && _validPoints.length == _points.length;

  void _scheduleQuotes() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _refreshQuotes);
  }

  Future<void> _refreshQuotes() async {
    if (!_routeReady || _city == null) {
      if (mounted) {
        setState(() {
          _quotes = <String, Quote>{};
          _quoteError = null;
        });
      }
      return;
    }
    setState(() => _quoting = true);
    try {
      final res = await widget.api.post('/api/orders/quote', {
        'cityId': _city!.id,
        'points': _validPoints,
        'serviceKind': _serviceKind,
        'options': _selectedOptions.toList(),
        if (_promoCtrl.text.trim().isNotEmpty && _promoOk) 'promoCode': _promoCtrl.text.trim().toUpperCase(),
        'plusMinusCents': _plusMinusCents,
        if (_scheduled && _scheduledAt != null) 'scheduledAt': _formatDateTime(_scheduledAt!),
      });
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      final quotes = asMapList(map['quotes']).map(Quote.fromJson).toList();
      if (!mounted) return;
      setState(() {
        _quotes = {for (final q in quotes) q.classId: q};
        _quoteError = null;
        if (_selectedClassId == null || !_quotes.containsKey(_selectedClassId)) {
          _selectedClassId = quotes.isEmpty ? null : quotes.first.classId;
        }
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _quoteError = e.message;
        _quotes = <String, Quote>{};
      });
    } finally {
      if (mounted) setState(() => _quoting = false);
    }
  }

  static String _formatDateTime(DateTime value) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${value.year}-${two(value.month)}-${two(value.day)} ${two(value.hour)}:${two(value.minute)}:00';
  }

  Quote? get _selectedQuote => _selectedClassId == null ? null : _quotes[_selectedClassId];

  Future<void> _editPoint(int index) async {
    if (_city == null) return;
    final address = await pickAddress(
      context,
      api: widget.api,
      cityId: _city!.id,
      title: index == 0 ? 'Звідки' : (index == _points.length - 1 ? 'Куди' : 'Зупинка ${index}'),
    );
    if (address == null || !mounted) return;
    setState(() => _points[index] = address);
    _scheduleQuotes();
  }

  void _addStop() {
    final stops = _points.length - 2;
    if (stops >= _maxStops) {
      showError(context, 'Максимум ${_maxStops} зупинок');
      return;
    }
    setState(() => _points.insert(_points.length - 1, null));
  }

  void _removePoint(int index) {
    if (index == 0 || index == _points.length - 1) return;
    setState(() => _points.removeAt(index));
    _scheduleQuotes();
  }

  Future<void> _applyPromo() async {
    final code = _promoCtrl.text.trim();
    if (code.isEmpty || _city == null || _selectedClassId == null || !_routeReady) {
      setState(() {
        _promoMessage = 'Спершу вкажіть маршрут і клас авто';
        _promoOk = false;
      });
      return;
    }
    try {
      final res = await widget.api.post('/api/promo/validate', {
        'code': code,
        'cityId': _city!.id,
        'classId': _selectedClassId,
        'points': _validPoints,
      });
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      final valid = map['valid'] == true;
      setState(() {
        _promoOk = valid;
        _promoMessage = valid
            ? 'Знижка ${money((map['discountCents'] as num?)?.toInt() ?? 0)}'
            : '${map['reason'] ?? 'Промокод не діє'}';
      });
      if (valid) _refreshQuotes();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _promoOk = false;
        _promoMessage = e.message;
      });
    }
  }

  Future<void> _pickSchedule() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: _scheduledAt ?? now.add(const Duration(hours: 1)),
      firstDate: now,
      lastDate: now.add(const Duration(days: 30)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_scheduledAt ?? now.add(const Duration(hours: 1))),
    );
    if (time == null || !mounted) return;
    setState(() {
      _scheduled = true;
      _scheduledAt = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
    _refreshQuotes();
  }

  Future<void> _submit() async {
    if (!_routeReady) {
      showError(context, 'Вкажіть адресу подачі та призначення');
      return;
    }
    if (_selectedClassId == null) {
      showError(context, 'Оберіть клас авто');
      return;
    }
    if (_serviceKind == 'delivery') {
      if (_senderNameCtrl.text.trim().isEmpty || _recipientNameCtrl.text.trim().isEmpty) {
        showError(context, 'Заповніть відправника та отримувача');
        return;
      }
    }
    setState(() => _submitting = true);
    try {
      final body = <String, dynamic>{
        'cityId': _city!.id,
        'classId': _selectedClassId,
        'serviceKind': _serviceKind,
        'points': _validPoints,
        'paymentMethod': _payment,
        'options': _selectedOptions.toList(),
        'plusMinusCents': _plusMinusCents,
        if (_commentCtrl.text.trim().isNotEmpty) 'comment': _commentCtrl.text.trim(),
        if (_promoOk && _promoCtrl.text.trim().isNotEmpty) 'promoCode': _promoCtrl.text.trim().toUpperCase(),
        if (_scheduled && _scheduledAt != null) 'scheduledAt': _formatDateTime(_scheduledAt!),
        if (_serviceKind == 'delivery')
          'delivery': {
            'senderName': _senderNameCtrl.text.trim(),
            'senderPhone': _senderPhoneCtrl.text.trim().isEmpty ? widget.session.phone : _senderPhoneCtrl.text.trim(),
            'recipientName': _recipientNameCtrl.text.trim(),
            'recipientPhone': _recipientPhoneCtrl.text.trim(),
            'weightKg': double.tryParse(_weightCtrl.text.replaceAll(',', '.')) ?? 1,
          },
      };
      final res = await widget.api.post('/api/orders', body);
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      final order = Order.fromJson(asMap(map['order']));
      if (!mounted) return;
      setState(() {
        _activeOrder = order;
        _promoOk = false;
        _promoCtrl.clear();
        _promoMessage = null;
        _commentCtrl.clear();
        _scheduled = false;
        _scheduledAt = null;
      });
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => OrderScreen(api: widget.api, session: widget.session, orderId: order.id),
        ),
      );
      if (mounted) await _loadActiveOrder();
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_details) return _buildHome();
    return Scaffold(
      appBar: RukhAppBar(
        title: 'Куди їдемо?',
        subtitle: _city?.name ?? 'РУХ',
        actions: [
          IconButton(tooltip: 'До мапи', onPressed: () => setState(() => _details = false), icon: const Icon(Icons.map_outlined)),
          IconButton(
            tooltip: 'Оновити',
            onPressed: _loading ? null : _bootstrap,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _bootstrap,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
                children: [
                  if (_error != null) ...[ErrorBox(message: _error!), const SizedBox(height: 12)],
                  if (_activeOrder != null) ...[
                    _ActiveOrderBanner(
                      order: _activeOrder!,
                      onOpen: () async {
                        await Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => OrderScreen(
                              api: widget.api,
                              session: widget.session,
                              orderId: _activeOrder!.id,
                            ),
                          ),
                        );
                        if (mounted) await _loadActiveOrder();
                      },
                    ),
                    const SizedBox(height: 12),
                  ],
                  _buildMapCard(),
                  const SizedBox(height: 12),
                  _buildServiceSelector(),
                  const SizedBox(height: 12),
                  _buildRouteCard(),
                  const SizedBox(height: 12),
                  if (_serviceKind == 'delivery') ...[_buildDeliveryCard(), const SizedBox(height: 12)],
                  if (_quoteError != null) ...[ErrorBox(message: _quoteError!), const SizedBox(height: 12)],
                  _buildClassesCard(),
                  const SizedBox(height: 12),
                  _buildExtrasCard(),
                  const SizedBox(height: 12),
                  _buildPaymentCard(),
                  const SizedBox(height: 16),
                  _buildSubmitBar(),
                ],
              ),
            ),
    );
  }

  Widget _buildHome() {
    const green = Color(0xFF00A663);
    final selected = _points.whereType<GeoAddress>().toList();
    final points = selected.map((p) => MapPoint(p.lat, p.lng)).toList();
    final quote = _selectedQuote;
    CarClass? selectedClass;
    for (final cls in _classes) {
      if (cls.id == _selectedClassId) selectedClass = cls;
    }
    return Scaffold(
      backgroundColor: Colors.white,
      body: LayoutBuilder(builder: (context, constraints) {
        final focus = points.isEmpty ? null : MapFocus.fit(points, viewport: Size(constraints.maxWidth, constraints.maxHeight * .55));
        return Stack(children: [
          Positioned.fill(child: OsmMap(
            center: focus?.center ?? const MapPoint(50.4501, 30.5234),
            zoom: focus?.zoom ?? 12,
            markers: [
              if (points.isNotEmpty) MapMarker(point: points.first, color: green, icon: Icons.circle),
              if (points.length > 1) MapMarker(point: points.last, color: const Color(0xFF263238), icon: Icons.circle),
            ],
            route: points,
            height: constraints.maxHeight,
          )),
          Positioned(top: MediaQuery.paddingOf(context).top + 12, left: 16,
            child: Material(color: Colors.white, shape: const CircleBorder(), elevation: 3,
              child: IconButton(tooltip: 'Меню', onPressed: widget.onMenu, icon: const Icon(Icons.menu), iconSize: 28))),
          if (_loading) const Positioned(top: 80, right: 20, child: CircularProgressIndicator()),
          if (_error != null) Positioned(top: 90, left: 16, right: 16,
            child: Material(color: Colors.white, borderRadius: BorderRadius.circular(12),
              child: ListTile(title: Text(_error!), trailing: IconButton(onPressed: _bootstrap, icon: const Icon(Icons.refresh))))),
          Align(alignment: Alignment.bottomCenter, child: Container(
            decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
              boxShadow: [BoxShadow(color: Color(0x22000000), blurRadius: 12)]),
            constraints: BoxConstraints(maxHeight: constraints.maxHeight * .7),
            child: SafeArea(top: false, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
              const SizedBox(height: 7),
              Container(width: 26, height: 4, decoration: BoxDecoration(color: const Color(0xFFC5D1D8), borderRadius: BorderRadius.circular(4))),
              for (int i = 0; i < _points.length; i++)
                InkWell(onTap: () => _editPoint(i), child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 9),
                  child: Row(children: [
                    Container(width: 22, height: 22, decoration: BoxDecoration(shape: BoxShape.circle, color: i == 0 ? green : const Color(0xFF263238)),
                      child: const Center(child: CircleAvatar(radius: 5, backgroundColor: Colors.white))),
                    const SizedBox(width: 20),
                    Expanded(child: Text(_points[i]?.label ?? (i == 0 ? 'Звідки...' : i == _points.length - 1 ? 'Куди...' : 'Зупинка'),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 20, color: _points[i] == null ? const Color(0xFF909DA6) : const Color(0xFF263238)))),
                    if (i == _points.length - 1 && _points.length == 2)
                      IconButton(tooltip: 'Додати зупинку', onPressed: _addStop, icon: const Icon(Icons.add_circle_outline, color: Color(0xFF8B9AA3)))
                    else if (i > 0 && i < _points.length - 1)
                      IconButton(tooltip: 'Видалити зупинку', onPressed: () => _removePoint(i), icon: const Icon(Icons.close)),
                  ]))),
              const Divider(height: 1, color: Color(0xFFE0E7EA)),
              Padding(padding: const EdgeInsets.fromLTRB(16, 12, 0, 12), child: Row(children: [
                const Icon(Icons.local_taxi, color: Color(0xFFFFC527), size: 37),
                const SizedBox(width: 12),
                Expanded(child: InkWell(onTap: () => setState(() => _details = true), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [Flexible(child: Text(selectedClass?.name ?? 'Клас авто', overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 19, color: Color(0xFF263238)))), const Icon(Icons.keyboard_arrow_down)]),
                  Text(selectedClass == null ? 'Оберіть клас' : 'до ${selectedClass.seats} пасажирів', style: const TextStyle(color: Color(0xFF7B8991), fontSize: 14)),
                ]))),
                Text(quote == null ? '—' : money(quote.totalCents), style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w700, color: Color(0xFF263238))),
                const SizedBox(width: 14),
                Material(color: const Color(0xFFFFC527), borderRadius: const BorderRadius.horizontal(left: Radius.circular(40)),
                  child: InkWell(onTap: () => setState(() => _details = true), borderRadius: const BorderRadius.horizontal(left: Radius.circular(40)),
                    child: const SizedBox(width: 68, height: 58, child: Icon(Icons.arrow_forward, color: Color(0xFF263238))))),
              ])),
              if (_activeOrder != null) TextButton(onPressed: () async {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderScreen(api: widget.api, session: widget.session, orderId: _activeOrder!.id)));
                if (mounted) await _loadActiveOrder();
              }, child: const Text('Відкрити активне замовлення')),
            ]))),
          )),
        ]);
      }),
    );
  }

  Widget _buildServiceSelector() {
    const items = <String, String>{
      'ride': 'Поїздка',
      'delivery': 'Доставка',
      'intercity': 'Міжмісто',
      'sober': 'Тверезий водій',
    };
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: items.entries.map((entry) {
          final selected = _serviceKind == entry.key;
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: ChoiceChip(
              label: Text(entry.value),
              selected: selected,
              onSelected: (value) async {
                if (!value) return;
                setState(() {
                  _serviceKind = entry.key;
                  _quotes = <String, Quote>{};
                  _selectedClassId = null;
                });
                await _loadCatalog();
              },
              selectedColor: RukhTheme.accent,
              labelStyle: TextStyle(color: selected ? RukhTheme.ink : RukhTheme.muted, fontWeight: FontWeight.w600),
              backgroundColor: RukhTheme.surfaceAlt,
              side: BorderSide.none,
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _buildRouteCard() {
    return SectionCard(
      title: 'Ваш маршрут',
      child: Column(
        children: [
          for (int i = 0; i < _points.length; i++)
            Builder(builder: (context) {
              final isFirst = i == 0;
              final isLast = i == _points.length - 1;
              final address = _points[i];
              final color = isFirst
                  ? RukhTheme.accent
                  : isLast
                      ? RukhTheme.ink
                      : RukhTheme.warning;
              return Column(
                children: [
                  InkWell(
                    onTap: () => _editPoint(i),
                    borderRadius: BorderRadius.circular(12),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(
                        children: [
                          Container(
                            width: 10,
                            height: 10,
                            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  isFirst ? 'ЗВІДКИ' : (isLast ? 'КУДИ' : 'ЗУПИНКА $i'),
                                  style: const TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  address?.label ?? 'Вказати адресу',
                                  style: TextStyle(
                                    fontSize: 15,
                                    color: address == null ? RukhTheme.muted : RukhTheme.ink,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (!isFirst && !isLast)
                            IconButton(
                              onPressed: () => _removePoint(i),
                              icon: const Icon(Icons.close, size: 18, color: RukhTheme.muted),
                            )
                          else
                            const Icon(Icons.chevron_right, color: RukhTheme.muted),
                        ],
                      ),
                    ),
                  ),
                  if (i < _points.length - 1)
                    Padding(
                      padding: const EdgeInsets.only(left: 4),
                      child: Row(
                        children: [
                          Container(width: 2, height: 10, color: Colors.black.withValues(alpha: 0.12)),
                        ],
                      ),
                    ),
                ],
              );
            }),
          const SizedBox(height: 6),
          Row(
            children: [
              TextButton.icon(
                onPressed: _addStop,
                icon: const Icon(Icons.add, size: 18),
                label: Text('Зупинка (${_points.length - 2}/$_maxStops)'),
              ),
              const Spacer(),
              if (_scheduledAt != null)
                TextButton.icon(
                  onPressed: () => setState(() {
                    _scheduled = false;
                    _scheduledAt = null;
                  }),
                  icon: const Icon(Icons.close, size: 16),
                  label: Text(dateTimeText(_scheduledAt!.toIso8601String()), style: const TextStyle(fontSize: 12)),
                )
              else
                TextButton.icon(
                  onPressed: _pickSchedule,
                  icon: const Icon(Icons.schedule, size: 18),
                  label: const Text('Попередньо'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildMapCard() {
    final selected = _points.whereType<GeoAddress>().toList();
    final points = selected.map((p) => MapPoint(p.lat, p.lng)).toList();
    // Київ — демонстраційний центр до вибору адреси, не місцезнаходження користувача.
    final focus = points.isEmpty ? null : MapFocus.fit(points, viewport: const Size(340, 230));
    final markers = <MapMarker>[];
    if (selected.isNotEmpty) {
      markers.add(MapPins.pickupPin(points.first, label: 'Звідки'));
      if (points.length > 1) markers.add(MapPins.dropoffPin(points.last, label: 'Куди'));
      for (var i = 1; i < points.length - 1; i++) {
        markers.add(MapPins.stopPin(points[i]));
      }
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: Stack(
        children: [
          OsmMap(
            center: focus?.center ?? const MapPoint(50.4501, 30.5234),
            zoom: focus?.zoom ?? 12,
            markers: markers,
            route: points,
            height: 230,
          ),
          if (points.isEmpty)
            Positioned(
              top: 12,
              left: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20)),
                child: const Text('Вкажіть адресу нижче', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildDeliveryCard() {
    return SectionCard(
      title: 'Доставка посилки (до 20 кг)',
      child: Column(
        children: [
          TextField(
            controller: _senderNameCtrl,
            decoration: const InputDecoration(labelText: 'Відправник'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _recipientNameCtrl,
            decoration: const InputDecoration(labelText: 'Отримувач'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _recipientPhoneCtrl,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Телефон отримувача'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _weightCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Вага, кг', helperText: 'Максимум 20 кг'),
          ),
        ],
      ),
    );
  }

  Widget _buildClassesCard() {
    if (_classes.isEmpty) {
      return const SectionCard(child: Text('Немає доступних класів у цьому місті'));
    }
    return SectionCard(
      title: 'Клас авто',
      child: Column(
        children: [
          for (final cls in _classes)
            Builder(builder: (context) {
              final quote = _quotes[cls.id];
              final selected = _selectedClassId == cls.id;
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  onTap: () => setState(() => _selectedClassId = cls.id),
                  borderRadius: BorderRadius.circular(14),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(14),
                      color: selected ? RukhTheme.accent.withValues(alpha: 0.1) : RukhTheme.surfaceAlt,
                      border: Border.all(
                        color: selected ? RukhTheme.accent : Colors.transparent,
                        width: 1,
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          cls.kind == 'delivery' ? Icons.inventory_2_outlined : Icons.directions_car_filled_outlined,
                          color: selected ? RukhTheme.accent : RukhTheme.muted,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(cls.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                              const SizedBox(height: 2),
                              Text(
                                '${cls.seats} місця · ${cls.luggage} багаж'
                                '${quote != null ? ' · ${durationText(quote.durationS)}' : ''}',
                                style: const TextStyle(color: RukhTheme.muted, fontSize: 11),
                              ),
                            ],
                          ),
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              quote == null ? (_quoting ? '…' : '—') : money(quote.totalCents),
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                                color: selected ? RukhTheme.ink : RukhTheme.muted,
                              ),
                            ),
                            if (quote != null && (quote.surge > 1 || quote.isNight))
                              Text(
                                [
                                  if (quote.surge > 1) '×${quote.surge.toStringAsFixed(1)} попит',
                                  if (quote.isNight) 'нічний',
                                ].join(' · '),
                                style: const TextStyle(color: RukhTheme.warning, fontSize: 10),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              );
            }),
          if (_selectedQuote != null) ...[
            const Divider(height: 20),
            ..._selectedQuote!.lines.map(
              (line) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  children: [
                    Expanded(child: Text('${line['label']}', style: const TextStyle(fontSize: 12, color: RukhTheme.muted))),
                    Text(money((line['amountCents'] as num?)?.toInt() ?? 0),
                        style: const TextStyle(fontSize: 12, color: RukhTheme.muted)),
                  ],
                ),
              ),
            ),
            if (_selectedQuote!.discountCents > 0)
              Row(
                children: [
                  const Expanded(child: Text('Знижка', style: TextStyle(fontSize: 12, color: RukhTheme.accent))),
                  Text('−${money(_selectedQuote!.discountCents)}',
                      style: const TextStyle(fontSize: 12, color: RukhTheme.accent)),
                ],
              ),
            if (_selectedQuote!.distanceM > 0)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  children: [
                    Text('${distanceText(_selectedQuote!.distanceM)} · ${durationText(_selectedQuote!.durationS)}',
                        style: const TextStyle(fontSize: 12, color: RukhTheme.muted)),
                    const Spacer(),
                    Text('подача ~${(_selectedQuote!.pickupEtaS / 60).ceil()} хв',
                        style: const TextStyle(fontSize: 12, color: RukhTheme.muted)),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _buildExtrasCard() {
    return SectionCard(
      title: 'Опції та знижки',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_options.isEmpty)
            const Text('Опцій немає', style: TextStyle(color: RukhTheme.muted, fontSize: 12)),
          ..._options.map((option) {
            final selected = _selectedOptions.contains(option.code);
            return CheckboxListTile(
              value: selected,
              onChanged: (value) {
                setState(() {
                  if (value == true) {
                    _selectedOptions.add(option.code);
                  } else {
                    _selectedOptions.remove(option.code);
                  }
                });
                _scheduleQuotes();
              },
              dense: true,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(option.name, style: const TextStyle(fontSize: 14)),
              subtitle: option.priceCents > 0
                  ? Text('+${money(option.priceCents)}', style: const TextStyle(fontSize: 11))
                  : null,
            );
          }),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _promoCtrl,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(labelText: 'Промокод', hintText: 'RUKH10'),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton.tonal(
                onPressed: _applyPromo,
                style: FilledButton.styleFrom(minimumSize: const Size(96, 52)),
                child: const Text('Дія'),
              ),
            ],
          ),
          if (_promoMessage != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _promoMessage!,
                style: TextStyle(color: _promoOk ? RukhTheme.accent : RukhTheme.danger, fontSize: 12),
              ),
            ),
          const SizedBox(height: 14),
          Row(
            children: [
              const Text('Плюс/Мінус', style: TextStyle(fontSize: 13)),
              const Spacer(),
              Text(
                _plusMinusCents == 0 ? 'без зміни' : money(_plusMinusCents),
                style: TextStyle(
                  fontSize: 13,
                  color: _plusMinusCents == 0
                      ? RukhTheme.muted
                      : (_plusMinusCents > 0 ? RukhTheme.accent : RukhTheme.warning),
                ),
              ),
            ],
          ),
          Slider(
            value: (_plusMinusCents / 100).clamp(-20, 20),
            min: -20,
            max: 20,
            divisions: 8,
            label: money(_plusMinusCents),
            onChanged: (value) => setState(() => _plusMinusCents = (value * 100).round()),
            onChangeEnd: (_) => _refreshQuotes(),
          ),
          TextField(
            controller: _commentCtrl,
            maxLength: 200,
            decoration: const InputDecoration(labelText: 'Коментар водію', counterText: ''),
          ),
        ],
      ),
    );
  }

  Widget _buildPaymentCard() {
    const methods = <String, String>{'cash': 'Готівка', 'card': 'Картка', 'wallet': 'Баланс'};
    return SectionCard(
      title: 'Оплата',
      child: Wrap(
        spacing: 8,
        children: methods.entries.map((entry) {
          final selected = _payment == entry.key;
          return ChoiceChip(
            label: Text(entry.value),
            selected: selected,
            onSelected: (value) {
              if (value) setState(() => _payment = entry.key);
            },
            selectedColor: RukhTheme.accent,
            labelStyle: TextStyle(color: selected ? RukhTheme.ink : RukhTheme.muted),
            backgroundColor: RukhTheme.surfaceAlt,
            side: BorderSide.none,
          );
        }).toList(),
      ),
    );
  }

  Widget _buildSubmitBar() {
    final quote = _selectedQuote;
    return Column(
      children: [
        if (quote != null)
          Row(
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('ДО СПЛАТИ', style: TextStyle(color: RukhTheme.muted, fontSize: 10, letterSpacing: 1)),
                  Text(money(quote.totalCents),
                      style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
                ],
              ),
              const Spacer(),
              Text(
                '${distanceText(quote.distanceM)}\n${durationText(quote.durationS)}',
                textAlign: TextAlign.right,
                style: const TextStyle(color: RukhTheme.muted, fontSize: 12),
              ),
            ],
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _submitting || !_routeReady ? null : _submit,
          child: _submitting
              ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: RukhTheme.ink))
              : Text(_routeReady ? 'Замовити за ${quote == null ? '—' : money(quote.totalCents)}' : 'Вкажіть маршрут'),
        ),
        const SizedBox(height: 8),
        Text(
          _scheduled
              ? 'Попереднє замовлення: ${dateTimeText(_scheduledAt?.toIso8601String())}'
              : 'Ціна фіксується в момент підтвердження',
          style: const TextStyle(color: RukhTheme.muted, fontSize: 11),
        ),
      ],
    );
  }
}

class _ActiveOrderBanner extends StatelessWidget {
  const _ActiveOrderBanner({required this.order, required this.onOpen});

  final Order order;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: RukhTheme.accent.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: RukhTheme.accent.withValues(alpha: 0.4)),
        ),
        child: Row(
          children: [
            const Icon(Icons.local_taxi, color: RukhTheme.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Активне замовлення №${order.number}',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  const SizedBox(height: 2),
                  Text('${statusLabel(order.status)} · ${money(order.priceCents)}',
                      style: const TextStyle(color: RukhTheme.muted, fontSize: 12)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: RukhTheme.accent),
          ],
        ),
      ),
    );
  }
}
