import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

/// Точка на мапі (WGS84).
class MapPoint {
  const MapPoint(this.lat, this.lng);
  final double lat;
  final double lng;

  @override
  bool operator ==(Object other) => other is MapPoint && other.lat == lat && other.lng == lng;

  @override
  int get hashCode => Object.hash(lat, lng);
}

class MapMarker {
  const MapMarker({
    required this.point,
    required this.color,
    this.icon = Icons.circle,
    this.label,
    this.size = 30,
  });

  final MapPoint point;
  final Color color;
  final IconData icon;
  final String? label;
  final double size;
}

/// Легка растрова мапа (slippy map) без зовнішніх пакетів: тайли вантажаться
/// через `dart:io` з кешем у памʼяті, проєкція — Web Mercator.
///
/// Стиль підібрано під OnTaxi/Google-light: світлі дороги (CARTO Positron),
/// пастельні зони, зелені та фіолетові маркери, темний контур маршруту.
/// Якщо основний провайдер недоступний — автоматичний фолбек на OpenStreetMap.
class OsmMap extends StatefulWidget {
  const OsmMap({
    super.key,
    required this.center,
    this.zoom = 14,
    this.markers = const <MapMarker>[],
    this.route = const <MapPoint>[],
    this.height = 220,
    this.interactive = true,
    this.showAttribution = true,
  });

  final MapPoint center;
  final double zoom;
  final List<MapMarker> markers;
  final List<MapPoint> route;
  final double height;
  final bool interactive;
  final bool showAttribution;

  @override
  State<OsmMap> createState() => _OsmMapState();
}

class _OsmMapState extends State<OsmMap> {
  static const double _tileSize = 256;
  static const double _minZoom = 10;
  static const double _maxZoom = 18;

  static final Map<String, Uint8List> _tileCache = <String, Uint8List>{};
  static final Map<String, Future<Uint8List?>> _inflight = <String, Future<Uint8List?>>{};

  late MapPoint _center;
  late double _zoom;

  MapPoint _startCenter = const MapPoint(0, 0);
  double _startZoom = 14;
  Offset _startFocal = Offset.zero;
  Size _viewport = Size.zero;

  @override
  void initState() {
    super.initState();
    _center = widget.center;
    _zoom = widget.zoom.clamp(_minZoom, _maxZoom);
  }

  @override
  void didUpdateWidget(covariant OsmMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Центр «підтягується» до нових даних (наприклад, водій призначений),
    // але жест користувача не скидається, якщо він уже зсунув мапу.
    if (oldWidget.center.lat != widget.center.lat || oldWidget.center.lng != widget.center.lng) {
      _center = widget.center;
    }
  }

  /* ------------------------------------------------------------ projection */
  Offset _toScreen(MapPoint p, double tileZoom, double cx, double cy) {
    final scale = math.pow(2, _zoom - tileZoom).toDouble();
    final dx = (Mercator.worldX(p, tileZoom) - cx) * scale;
    final dy = (Mercator.worldY(p, tileZoom) - cy) * scale;
    return Offset(_viewport.width / 2 + dx, _viewport.height / 2 + dy);
  }

  /* ---------------------------------------------------------------- tiles */
  Future<Uint8List?> _loadTile(int z, int x, int y) {
    final key = '$z/$x/$y';
    final cached = _tileCache[key];
    if (cached != null) return Future<Uint8List?>.value(cached);
    final pending = _inflight[key];
    if (pending != null) return pending;

    final future = () async {
      for (final url in <String>[
        // Основний провайдер: OpenStreetMap (вільні тайли, потрібен User-Agent).
        // CARTO/Stamen світлі стилі з 2026-го вимагають API-ключа й віддають
        // водяний знак, тому світлий вигляд робимо фільтром на клієнті.
        'https://tile.openstreetmap.org/$z/$x/$y.png',
        'https://tile.openstreetmap.fr/hot/$z/$x/$y.png',
      ]) {
        try {
          final bytes = await _fetch(Uri.parse(url));
          if (bytes != null && bytes.isNotEmpty) {
            if (_tileCache.length > 400) _tileCache.clear();
            _tileCache[key] = bytes;
            return bytes;
          }
        } catch (_) {
          /* пробуємо наступний провайдер */
        }
      }
      return null;
    }();
    _inflight[key] = future;
    return future.whenComplete(() => _inflight.remove(key));
  }

  static Future<Uint8List?> _fetch(Uri uri) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final req = await client.getUrl(uri);
      req.headers.set('user-agent', 'RUKH-taxi-app/0.2 (Flutter; demo build)');
      final res = await req.close();
      if (res.statusCode != 200) return null;
      final builder = BytesBuilder(copy: false);
      await for (final chunk in res) {
        builder.add(chunk);
      }
      return builder.takeBytes();
    } finally {
      client.close(force: true);
    }
  }

  /* ------------------------------------------------------------- gestures */
  void _onScaleStart(ScaleStartDetails details) {
    _startCenter = _center;
    _startZoom = _zoom;
    _startFocal = details.localFocalPoint;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    if (!widget.interactive || _viewport == Size.zero) return;
    final tileZoom = _startZoom.roundToDouble();
    final startCx = Mercator.worldX(_startCenter, tileZoom);
    final startCy = Mercator.worldY(_startCenter, tileZoom);
    // світова координата точки під пальцем на початку жесту
    final anchorX = startCx + (_startFocal.dx - _viewport.width / 2) / math.pow(2, _startZoom - tileZoom);
    final anchorY = startCy + (_startFocal.dy - _viewport.height / 2) / math.pow(2, _startZoom - tileZoom);

    final zoomDelta = details.scale <= 0 ? 0.0 : math.log(details.scale) / math.ln2;
    final newZoom = (_startZoom + zoomDelta).clamp(_minZoom, _maxZoom);
    final scale = math.pow(2, newZoom - tileZoom).toDouble();

    final newCx = anchorX - (details.localFocalPoint.dx - _viewport.width / 2) / scale;
    final newCy = anchorY - (details.localFocalPoint.dy - _viewport.height / 2) / scale;

    setState(() {
      _zoom = newZoom;
      _center = Mercator.fromWorld(newCx, newCy, tileZoom);
    });
  }

  void _zoomBy(double delta) {
    setState(() => _zoom = (_zoom + delta).clamp(_minZoom, _maxZoom));
  }

  /* ------------------------------------------------------------------ ui */
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(
        height: widget.height,
        width: double.infinity,
        child: LayoutBuilder(
          builder: (context, constraints) {
            _viewport = Size(constraints.maxWidth, constraints.maxHeight);
            final tileZoom = _zoom.round().clamp(_minZoom.toInt(), _maxZoom.toInt()).toDouble();
            final cx = Mercator.worldX(_center, tileZoom);
            final cy = Mercator.worldY(_center, tileZoom);
            final scale = math.pow(2, _zoom - tileZoom).toDouble();
            final n = 1 << tileZoom.toInt();

            final halfW = _viewport.width / (2 * scale);
            final halfH = _viewport.height / (2 * scale);
            final firstX = ((cx - halfW) / _tileSize).floor();
            final lastX = ((cx + halfW) / _tileSize).floor();
            final firstY = ((cy - halfH) / _tileSize).floor().clamp(0, n - 1);
            final lastY = ((cy + halfH) / _tileSize).floor().clamp(0, n - 1);
            final tilePx = _tileSize * scale;

            final tiles = <Widget>[];
            for (var ty = firstY; ty <= lastY; ty++) {
              for (var tx = firstX; tx <= lastX; tx++) {
                final wrappedX = tx % n;
                final left = (tx * _tileSize - cx) * scale + _viewport.width / 2;
                final top = (ty * _tileSize - cy) * scale + _viewport.height / 2;
                tiles.add(Positioned(
                  left: left,
                  top: top,
                  width: tilePx + 0.8,
                  height: tilePx + 0.8,
                  child: _TileImage(
                    future: _loadTile(tileZoom.toInt(), wrappedX, ty),
                  ),
                ));
              }
            }

            final markerWidgets = <Widget>[];
            for (final marker in widget.markers) {
              final pos = _toScreen(marker.point, tileZoom, cx, cy);
              markerWidgets.add(Positioned(
                left: pos.dx - marker.size / 2,
                top: pos.dy - marker.size,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (marker.label != null)
                      Container(
                        margin: const EdgeInsets.only(bottom: 3),
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(6),
                          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.18), blurRadius: 6)],
                        ),
                        child: Text(
                          marker.label!,
                          style: const TextStyle(fontSize: 10, color: Color(0xFF1A1A1A), fontWeight: FontWeight.w600),
                        ),
                      ),
                    Icon(marker.icon, size: marker.size, color: marker.color),
                  ],
                ),
              ));
            }

            final routePoints = widget.route
                .map((p) => _toScreen(p, tileZoom, cx, cy))
                .toList(growable: false);

            return Stack(
              children: [
                const Positioned.fill(child: ColoredBox(color: Color(0xFFF2F1EC))),
                // світлий «повітряний» фільтр як у OnTaxi/Google-light
                Positioned.fill(
                  child: ColorFiltered(
                    // десатурація + підняття яскравості → світлий «паперовий»
                    // стиль у дусі Google-light / OnTaxi
                    colorFilter: const ColorFilter.matrix(<double>[
                      0.62, 0.30, 0.08, 0, 26,
                      0.16, 0.78, 0.06, 0, 26,
                      0.14, 0.26, 0.60, 0, 26,
                      0, 0, 0, 1, 0,
                    ]),
                    child: Stack(children: tiles),
                  ),
                ),
                if (routePoints.length >= 2)
                  Positioned.fill(
                    child: IgnorePointer(
                      child: CustomPaint(painter: _RoutePainter(routePoints)),
                    ),
                  ),
                if (widget.interactive)
                  Positioned.fill(
                    child: GestureDetector(
                      onScaleStart: _onScaleStart,
                      onScaleUpdate: _onScaleUpdate,
                      behavior: HitTestBehavior.translucent,
                    ),
                  ),
                ...markerWidgets,
                if (widget.interactive) ...[
                  Positioned(
                    right: 8,
                    bottom: 8,
                    child: Column(
                      children: [
                        _MapButton(icon: Icons.add, onTap: () => _zoomBy(1)),
                        const SizedBox(height: 6),
                        _MapButton(icon: Icons.remove, onTap: () => _zoomBy(-1)),
                      ],
                    ),
                  ),
                ],
                if (widget.showAttribution)
                  Positioned(
                    left: 6,
                    bottom: 4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.72),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text(
                        '© OpenStreetMap',
                        style: TextStyle(fontSize: 8.5, color: Color(0xFF5B6166)),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _TileImage extends StatelessWidget {
  const _TileImage({required this.future});

  final Future<Uint8List?> future;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List?>(
      future: future,
      builder: (context, snapshot) {
        final bytes = snapshot.data;
        if (bytes == null) {
          return ColoredBox(
            color: snapshot.connectionState == ConnectionState.done
                ? const Color(0xFFEDEBE6)
                : const Color(0xFFF2F1EC),
          );
        }
        return Image.memory(
          bytes,
          fit: BoxFit.cover,
          gaplessPlayback: true,
          filterQuality: FilterQuality.low,
        );
      },
    );
  }
}

class _MapButton extends StatelessWidget {
  const _MapButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(8),
      elevation: 2,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          width: 34,
          height: 34,
          child: Icon(icon, size: 18, color: const Color(0xFF33383D)),
        ),
      ),
    );
  }
}

class _RoutePainter extends CustomPainter {
  _RoutePainter(this.points);

  final List<Offset> points;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2) return;
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (var i = 1; i < points.length; i++) {
      path.lineTo(points[i].dx, points[i].dy);
    }
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 9
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = Colors.white.withValues(alpha: 0.95),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = const Color(0xFF15181B),
    );
  }

  @override
  bool shouldRepaint(covariant _RoutePainter oldDelegate) => oldDelegate.points != points;
}

/// Центр і масштаб, що вміщують усі точки маршруту.
class MapFocus {
  const MapFocus(this.center, this.zoom);

  final MapPoint center;
  final double zoom;

  /// Підбирає центр і масштаб так, щоб усі точки вмістились у вьюпорт
  /// з полями ~12%. Враховує і широтний, і довготний розмах (мапа не квадратна).
  static MapFocus fit(
    List<MapPoint> points, {
    Size viewport = const Size(340, 210),
    double padding = 1.24,
  }) {
    if (points.isEmpty) return const MapFocus(MapPoint(50.4501, 30.5234), 13);
    if (points.length == 1) return MapFocus(points.first, 15);

    var minLat = points.first.lat, maxLat = points.first.lat;
    var minLng = points.first.lng, maxLng = points.first.lng;
    for (final p in points) {
      minLat = math.min(minLat, p.lat);
      maxLat = math.max(maxLat, p.lat);
      minLng = math.min(minLng, p.lng);
      maxLng = math.max(maxLng, p.lng);
    }
    final center = MapPoint((minLat + maxLat) / 2, (minLng + maxLng) / 2);
    final spanY = _meters(minLat, center.lng, maxLat, center.lng);
    final spanX = _meters(center.lat, minLng, center.lat, maxLng);
    const metersPerPixelEquator = 156543.03392;
    final cosLat = math.cos(center.lat * math.pi / 180).clamp(0.2, 1.0);
    final pxPerMeter = viewport.width / (math.max(spanX, 60) * padding);
    final pxPerMeterY = viewport.height / (math.max(spanY, 60) * padding);
    // щоб вмістити обидві осі, беремо жорсткішу (менш масштабовану) вимогу
    final needed = math.min(pxPerMeter, pxPerMeterY);
    final zoom = (math.log(metersPerPixelEquator * cosLat * needed) / math.ln2).clamp(11.0, 17.0);
    return MapFocus(center, zoom);
  }

  static double _meters(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = (lat2 - lat1) * math.pi / 180;
    final dLng = (lng2 - lng1) * math.pi / 180;
    final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) * math.sin(dLng / 2) * math.sin(dLng / 2);
    return 2 * r * math.asin(math.min(1, math.sqrt(a)));
  }
}

/// Готові маркери в палітрі OnTaxi: зелена точка подачі,
/// фіолетова — призначення, бурштинова — проміжна зупинка.
class MapPins {
  static const Color pickup = Color(0xFF2FBF71);
  static const Color dropoff = Color(0xFF9B51E0);
  static const Color stop = Color(0xFFF2A33C);
  static const Color driver = Color(0xFF15181B);

  static MapMarker pickupPin(MapPoint point, {String? label}) =>
      MapMarker(point: point, color: pickup, icon: Icons.trip_origin, label: label, size: 26);

  static MapMarker dropoffPin(MapPoint point, {String? label}) =>
      MapMarker(point: point, color: dropoff, icon: Icons.place, label: label, size: 30);

  static MapMarker stopPin(MapPoint point) =>
      MapMarker(point: point, color: stop, icon: Icons.circle, size: 16);

  static MapMarker driverPin(MapPoint point) =>
      MapMarker(point: point, color: driver, icon: Icons.local_taxi, size: 28);
}


/// Проєкція Web Mercator — публічна, щоб її можна було перевіряти тестами.
class Mercator {
  /// Розмір тайла в пікселях (стандарт slippy map).
  static const double tileSize = 256;

/// Web Mercator → світові пікселі (публічні для тестів і перевірки проєкції).
  static double worldX(MapPoint p, double zoom) {
    final n = tileSize * math.pow(2, zoom);
    return (p.lng + 180) / 360 * n;
  }

  static double worldY(MapPoint p, double zoom) {
    final n = tileSize * math.pow(2, zoom);
    final sinLat = math.sin(p.lat * math.pi / 180).clamp(-0.9999, 0.9999);
    final y = 0.5 - math.log((1 + sinLat) / (1 - sinLat)) / (4 * math.pi);
    return y * n;
  }

  static MapPoint fromWorld(double x, double y, double zoom) {
    final n = tileSize * math.pow(2, zoom);
    final lng = x / n * 360 - 180;
    final merc = 0.5 - y / n;
    final lat = 90 - 360 * math.atan(math.exp(-merc * 2 * math.pi)) / math.pi;
    return MapPoint(lat, lng);
  }
}
