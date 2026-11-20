import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rukh_mobile/widgets/osm_map.dart';

void main() {
  test('Web Mercator: проєкція Києва збігається з еталоном', () {
    const kyiv = MapPoint(50.4501, 30.5234);
    final x = Mercator.worldX(kyiv, 14);
    final y = Mercator.worldY(kyiv, 14);
    expect(x, closeTo(2452775.3853, 0.01));
    expect(y, closeTo(1414279.4846, 0.01));
  });

  test('зворотна проєкція повертає ті самі координати', () {
    const point = MapPoint(49.9935, 36.2304); // Харків
    final back = Mercator.fromWorld(Mercator.worldX(point, 15), Mercator.worldY(point, 15), 15);
    expect(back.lat, closeTo(point.lat, 1e-6));
    expect(back.lng, closeTo(point.lng, 1e-6));
  });

  test('MapFocus вміщує маршрут і тримає масштаб у межах', () {
    final focus = MapFocus.fit(const [MapPoint(50.4501, 30.5234), MapPoint(50.4300, 30.5200)]);
    expect(focus.center.lat, closeTo(50.44005, 1e-6));
    expect(focus.zoom, inInclusiveRange(11, 17));
    // довший маршрут → менший зум
    final long = MapFocus.fit(const [MapPoint(50.4501, 30.5234), MapPoint(49.8397, 24.0297)]); // Київ–Львів
    expect(long.zoom, lessThan(focus.zoom));
  });

  testWidgets('мапа рендериться з маркерами й маршрутом без помилок', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 360,
            child: OsmMap(
              center: MapPoint(50.4501, 30.5234),
              zoom: 14,
              height: 220,
              route: [MapPoint(50.4501, 30.5234), MapPoint(50.4300, 30.5200)],
              markers: [
                MapMarker(point: MapPoint(50.4501, 30.5234), color: MapPins.pickup, label: 'Звідки'),
                MapMarker(point: MapPoint(50.4300, 30.5200), color: MapPins.dropoff, label: 'Куди'),
              ],
            ),
          ),
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 50));
    expect(tester.takeException(), isNull);
    expect(find.text('Звідки'), findsOneWidget);
    expect(find.text('Куди'), findsOneWidget);
    expect(find.byIcon(Icons.add), findsOneWidget);
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump(const Duration(milliseconds: 50));
    expect(tester.takeException(), isNull);
  });

  testWidgets('переміщення не перезапускає завантаження видимих тайлів', (tester) async {
    final calls = <String, int>{};
    final Uint8List pixel = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XzXkAAAAASUVORK5CYII=',
    );
    Future<Uint8List?> load(int z, int x, int y) async {
      final key = '$z/$x/$y';
      calls[key] = (calls[key] ?? 0) + 1;
      return pixel;
    }
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: SizedBox(
      width: 360, child: OsmMap(center: const MapPoint(50.45, 30.52), zoom: 14, height: 220, tileLoader: load),
    )))));
    await tester.pump();
    final before = Map<String, int>.of(calls);
    expect(before, isNotEmpty);
    await tester.drag(find.byType(OsmMap), const Offset(12, 6));
    await tester.pump();
    for (final entry in before.entries) {
      expect(calls[entry.key], entry.value, reason: 'Тайл ${entry.key} не має перезапитуватись при русі');
    }
    expect(tester.takeException(), isNull);
  });

}
