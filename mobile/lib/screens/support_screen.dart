// Переписка з підтримкою по конкретному зверненню: історія повідомлень,
// відповідь користувача, автооновлення (агент може відповісти з адмінки).
import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../theme.dart';
import 'shell.dart';

class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, required this.api, required this.ticketId, this.subject = ''});

  final ApiClient api;
  final String ticketId;
  final String subject;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();
  List<Map<String, dynamic>> _messages = <Map<String, dynamic>>[];
  Map<String, dynamic> _ticket = <String, dynamic>{};
  bool _loading = true;
  bool _sending = false;
  String? _error;
  Timer? _poller;

  @override
  void initState() {
    super.initState();
    _load();
    // Агент відповідає з адмінки — підтягуємо нові повідомлення без дій користувача.
    _poller = Timer.periodic(const Duration(seconds: 6), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _poller?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final res = await widget.api.get('/api/support/tickets/${widget.ticketId}');
      final map = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _ticket = asMap(map['ticket']);
        _messages = asMapList(map['messages']);
        _error = null;
        _loading = false;
      });
      _scrollToEnd();
    } on ApiException catch (e) {
      if (mounted) setState(() {
        if (!silent) _error = e.message;
        _loading = false;
      });
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.api.post('/api/support/tickets/${widget.ticketId}/messages', {'message': text});
      _input.clear();
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final subject = '${_ticket['subject'] ?? widget.subject}';
    final status = '${_ticket['status'] ?? ''}';
    return Scaffold(
      appBar: RukhAppBar(
        title: subject.isEmpty ? 'Підтримка' : subject,
        subtitle: switch (status) {
          'open' => 'Відкрите',
          'pending' => 'Очікує відповіді',
          'closed' => 'Закрите',
          _ => 'Звернення',
        },
      ),
      body: Column(
        children: [
          if (_error != null) ErrorBox(message: _error!),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) {
                      final message = _messages[index];
                      final mine = '${message['author_role']}' == 'user';
                      return Align(
                        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                          decoration: BoxDecoration(
                            color: mine ? RukhTheme.accent.withValues(alpha: 0.16) : RukhTheme.surfaceAlt,
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${message['body']}', style: const TextStyle(fontSize: 14, height: 1.35)),
                              const SizedBox(height: 4),
                              Text(
                                mine ? 'ви' : 'підтримка РУХ',
                                style: const TextStyle(fontSize: 10, color: RukhTheme.muted),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: const InputDecoration(hintText: 'Написати повідомлення'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _sending ? null : _send,
                    icon: _sending
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
