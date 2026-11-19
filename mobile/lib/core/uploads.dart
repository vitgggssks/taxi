// Завантаження файлів у API: фото вручення посилки, документи водія, аватар.
// Сервер повертає відносний шлях (`/uploads/up_x.png`), тому клієнт дописує
// до нього активну адресу API — так само, як і для решти запитів.
import 'dart:convert';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

import 'api.dart';

class Uploads {
  Uploads(this.api);

  final ApiClient api;
  final ImagePicker _picker = ImagePicker();

  /// Вибір/зйомка зображення. Камера — для фото вручення й документів.
  Future<Uint8List?> pickImage({required ImageSource source, int maxSide = 1600, int quality = 80}) async {
    final file = await _picker.pickImage(source: source, maxWidth: maxSide.toDouble(), maxHeight: maxSide.toDouble(), imageQuality: quality);
    if (file == null) return null;
    return file.readAsBytes();
  }

  /// Відправляє байти на сервер і повертає абсолютне посилання.
  Future<String> upload({required Uint8List bytes, String mime = 'image/jpeg'}) async {
    final res = await api.post('/api/uploads', {
      'dataUrl': 'data:$mime;base64,${base64Encode(bytes)}',
    });
    final path = res is Map ? '${res['url']}' : '';
    if (path.isEmpty) throw ApiException(0, 'upload_failed', 'Сервер не повернув посилання на файл');
    return api.absoluteUrl(path);
  }

  /// Вибір + завантаження одним викликом. `null` — користувач скасував.
  Future<String?> pickAndUpload({ImageSource source = ImageSource.camera}) async {
    final bytes = await pickImage(source: source);
    if (bytes == null) return null;
    return upload(bytes: bytes);
  }
}
