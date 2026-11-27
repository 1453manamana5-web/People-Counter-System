# 独立バックエンド構築
- 専用 Firebase プロジェクト: people-counter-system-aed75。ブラウザ向け設定は登録済み。Analytics SDK は利用しない。
- Firebase Consoleで Authentication のメール/パスワードおよび匿名認証を有効化する。
- Firestore Standard、データベース ID (default)、asia-northeast1（東京）、本番モードで開始する。既に作成済みなら変更しない。
- 初回管理者はコンソールでメール/パスワードのユーザーを作成し、UIDを控える。Firestore の counterManagers/{uid} に name (string), role (string: admin), enabled (boolean: true) を登録する。公開アプリに管理者を自己登録する機能は付けない。
- 管理アプリのログイン画面から確認メールを送信できる。確認完了後に再ログインする。
- docs/firestore.candidate.rules は検証前の候補。権限境界のエミュレータ試験が通るまで本番 firestore.rules の全拒否を維持する。
- GitHub Pages 公開は別途設定する。QRプロジェクトの設定・利用者・データは移行しない。
