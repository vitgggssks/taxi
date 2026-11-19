/// Типізовані моделі домену RUKH (відповідають JSON-контрактам /api/*).

int _int(dynamic v) {
  if (v is int) return v;
  if (v is num) return v.round();
  return int.tryParse('$v') ?? 0;
}

double _double(dynamic v) {
  if (v is num) return v.toDouble();
  return double.tryParse('$v') ?? 0;
}

String? _str(dynamic v) => v == null ? null : '$v';

Map<String, dynamic> asMap(dynamic v) {
  if (v is! Map) return <String, dynamic>{};
  final out = <String, dynamic>{};
  v.forEach((key, value) => out['$key'] = value);
  return out;
}

List<Map<String, dynamic>> asMapList(dynamic v) =>
    v is List ? v.whereType<Map>().map((e) => asMap(e)).toList() : <Map<String, dynamic>>[];

class City {
  City.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        name = '${j['name']}',
        region = _str(j['region']),
        currency = '${j['currency'] ?? 'UAH'}';

  final String id;
  final String name;
  final String? region;
  final String currency;
}

class CarClass {
  CarClass.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        code = '${j['code']}',
        name = '${j['name']}',
        kind = '${j['kind'] ?? 'ride'}',
        seats = _int(j['seats']),
        luggage = _int(j['luggage']);

  final String id;
  final String code;
  final String name;
  final String kind;
  final int seats;
  final int luggage;
}

class OrderOption {
  OrderOption.fromJson(Map<String, dynamic> j)
      : code = '${j['code']}',
        name = '${j['name']}',
        description = _str(j['description']),
        priceCents = _int(j['price_cents']),
        maxQty = _int(j['max_qty'] ?? 1);

  final String code;
  final String name;
  final String? description;
  final int priceCents;
  final int maxQty;
}

class GeoAddress {
  GeoAddress.fromJson(Map<String, dynamic> j)
      : label = '${j['label']}',
        lat = _double(j['lat']),
        lng = _double(j['lng']);

  final String label;
  final double lat;
  final double lng;

  Map<String, dynamic> toPointJson() => {'address': label, 'lat': lat, 'lng': lng};
}

class Quote {
  Quote.fromJson(Map<String, dynamic> j)
      : classId = '${j['classId']}',
        classCode = '${j['classCode']}',
        className = '${j['className']}',
        currency = '${j['currency'] ?? 'UAH'}',
        distanceM = _int(j['distanceM']),
        durationS = _int(j['durationS']),
        pickupEtaS = _int(j['pickupEtaS']),
        fareCents = _int(j['fareCents']),
        totalCents = _int(j['totalCents']),
        discountCents = _int(j['discountCents']),
        plusMinusCents = _int(j['plusMinusCents']),
        commissionPct = _double(j['commissionPct']),
        breakdown = asMap(j['breakdown']),
        lines = asMapList(j['lines']);

  final String classId;
  final String classCode;
  final String className;
  final String currency;
  final int distanceM;
  final int durationS;
  final int pickupEtaS;
  final int fareCents;
  final int totalCents;
  final int discountCents;
  final int plusMinusCents;
  final double commissionPct;
  final Map<String, dynamic> breakdown;
  final List<Map<String, dynamic>> lines;

  bool get isNight => _double(breakdown['nightMultiplier']) > 1;
  double get surge => _double(breakdown['surgeMultiplier']);
}

class OrderPoint {
  OrderPoint.fromJson(Map<String, dynamic> j)
      : seq = _int(j['seq']),
        kind = '${j['kind']}',
        address = '${j['address']}',
        lat = _double(j['lat']),
        lng = _double(j['lng']),
        note = _str(j['note']);

  final int seq;
  final String kind;
  final String address;
  final double lat;
  final double lng;
  final String? note;
}

class DriverInfo {
  DriverInfo.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        name = _str(j['name']) ?? 'Водій',
        phone = _str(j['phone']) ?? '',
        rating = _double(j['rating'] ?? 5);

  final String id;
  final String name;
  final String phone;
  final double rating;
}

class VehicleInfo {
  VehicleInfo.fromJson(Map<String, dynamic> j)
      : make = '${j['make'] ?? ''}',
        model = '${j['model'] ?? ''}',
        plate = '${j['plate'] ?? ''}',
        color = '${j['color'] ?? ''}';

  final String make;
  final String model;
  final String plate;
  final String color;

  String get title => '$make $model'.trim();
}

class Order {
  Order.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        number = '${j['number']}',
        status = '${j['status']}',
        serviceKind = '${j['service_kind'] ?? 'ride'}',
        paymentMethod = '${j['payment_method'] ?? 'cash'}',
        paymentStatus = '${j['payment_status'] ?? 'pending'}',
        quotedPriceCents = _int(j['quoted_price_cents']),
        finalPriceCents = j['final_price_cents'] == null ? null : _int(j['final_price_cents']),
        cashbackCents = _int(j['cashback_cents']),
        distanceM = _int(j['distance_m']),
        durationS = _int(j['duration_s']),
        comment = _str(j['comment']),
        createdAt = '${j['created_at'] ?? ''}',
        scheduledAt = _str(j['scheduled_at']),
        rating = j['rating'] == null ? null : _int(j['rating']),
        cancelReason = _str(j['cancel_reason']),
        cityId = '${j['city_id'] ?? ''}',
        classId = '${j['class_id'] ?? ''}',
        points = asMapList(j['points']).map(OrderPoint.fromJson).toList(),
        driver = j['driver'] == null ? null : DriverInfo.fromJson(asMap(j['driver'])),
        vehicle = j['vehicle'] == null ? null : VehicleInfo.fromJson(asMap(j['vehicle'])),
        delivery = j['delivery'] == null ? null : asMap(j['delivery']);

  final String id;
  final String number;
  final String status;
  final String serviceKind;
  final String paymentMethod;
  final String paymentStatus;
  final int quotedPriceCents;
  final int? finalPriceCents;
  final int cashbackCents;
  final int distanceM;
  final int durationS;
  final String? comment;
  final String createdAt;
  final String? scheduledAt;
  final int? rating;
  final String? cancelReason;
  final String cityId;
  final String classId;
  final List<OrderPoint> points;
  final DriverInfo? driver;
  final VehicleInfo? vehicle;
  final Map<String, dynamic>? delivery;

  int get priceCents => finalPriceCents ?? quotedPriceCents;
  bool get isActive => const [
        'searching',
        'offered',
        'no_drivers',
        'assigned',
        'driver_arriving',
        'waiting',
        'in_progress',
      ].contains(status);
  bool get canRate => status == 'completed' && rating == null;

  String get pickupAddress => points.isEmpty ? '' : points.first.address;
  String get dropoffAddress => points.isEmpty ? '' : points.last.address;
}

class Offer {
  Offer.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        priceCents = _int(j['price_cents']),
        distanceToPickupM = _int(j['distance_to_pickup_m']),
        etaToPickupS = _int(j['eta_to_pickup_s']),
        secondsLeft = _int(j['secondsLeft']),
        round = _int(j['round'] ?? 1),
        paymentMethod = '${j['payment_method'] ?? 'cash'}',
        order = Order.fromJson(asMap(j['order']));

  final String id;
  final int priceCents;
  final int distanceToPickupM;
  final int etaToPickupS;
  final int secondsLeft;
  final int round;
  final String paymentMethod;
  final Order order;
}

class WalletTxn {
  WalletTxn.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        kind = '${j['kind']}',
        account = '${j['account'] ?? 'main'}',
        amountCents = _int(j['amount_cents']),
        createdAt = '${j['created_at'] ?? ''}';

  final String id;
  final String kind;
  final String account;
  final int amountCents;
  final String createdAt;
}

class DriverProfile {
  DriverProfile.fromJson(Map<String, dynamic> j)
      : status = '${j['status'] ?? 'pending'}',
        workStatus = '${j['work_status'] ?? 'offline'}',
        rating = _double(j['rating'] ?? 5),
        ratingCount = _int(j['rating_count']),
        ordersCompleted = _int(j['orders_completed']),
        offersTotal = _int(j['offers_total']),
        offersAccepted = _int(j['offers_accepted']),
        balanceCents = _int(j['balance_cents']),
        commissionPct = _double(j['commission_pct'] ?? 15),
        autoAccept = j['auto_accept'] == 1 || j['auto_accept'] == true;

  final String status;
  final String workStatus;
  final double rating;
  final int ratingCount;
  final int ordersCompleted;
  final int offersTotal;
  final int offersAccepted;
  final int balanceCents;
  final double commissionPct;
  final bool autoAccept;

  bool get online => workStatus != 'offline';
  double get acceptRate => offersTotal == 0 ? 0 : offersAccepted / offersTotal;
}
