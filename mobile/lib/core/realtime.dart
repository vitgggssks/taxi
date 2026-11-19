import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'api.dart';

typedef RealtimeListener = void Function(String event, dynamic payload);

/// WebSocket-клієнт: підписки на канали, автоперепідключення з backoff.
/// Після реконекту канали відновлюються, а UI має перезапитати стан через REST.
class Realtime {
  Realtime({required this.api, required this.onEvent});

  final ApiClient api;
  final RealtimeListener onEvent;

  final Set<String> _channels = <String>{};
  WebSocket? _socket;
  Timer? _retry;
  bool _disposed = false;
  int _attempt = 0;

  bool get connected => _socket != null;

  Future<void> connect() async {
    if (_disposed) return;
    final token = api.token;
    if (token == null || token.isEmpty) return;
    _retry?.cancel();
    try {
      final socket = await WebSocket.connect(api.wsUri(token).toString());
      if (_disposed) {
        await socket.close();
        return;
      }
      _socket = socket;
      _attempt = 0;
      socket.listen(
        (raw) {
          final decoded = jsonDecode(raw as String);
          if (decoded is Map && decoded['event'] is String) {
            onEvent(decoded['event'] as String, decoded['payload']);
          }
        },
        onDone: _scheduleReconnect,
        onError: (_) => _scheduleReconnect(),
        cancelOnError: true,
      );
      for (final channel in _channels) {
        socket.add(jsonEncode({'type': 'subscribe', 'channel': channel}));
      }
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void subscribe(String channel) {
    if (_channels.contains(channel)) return;
    _channels.add(channel);
    _socket?.add(jsonEncode({'type': 'subscribe', 'channel': channel}));
  }

  void unsubscribe(String channel) {
    _channels.remove(channel);
    _socket?.add(jsonEncode({'type': 'unsubscribe', 'channel': channel}));
  }

  void _scheduleReconnect() {
    _socket = null;
    if (_disposed) return;
    _attempt = (_attempt + 1).clamp(1, 6);
    final delay = Duration(seconds: 1 << (_attempt - 1));
    _retry?.cancel();
    _retry = Timer(delay, () {
      if (!_disposed) connect();
    });
  }

  void dispose() {
    _disposed = true;
    _retry?.cancel();
    final socket = _socket;
    _socket = null;
    socket?.close();
  }
}
