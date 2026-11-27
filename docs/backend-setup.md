# 独立バックエンド構築
- 専用 Firebase プロジェクト: people-counter-system-aed75。ブラウザ向け設定は登録済み。Analytics SDK は利用しない。
- Firebase Consoleで Authentication のメール/パスワードおよび匿名認証を有効化する。
- Firestore Standard、データベース ID (default)、asia-northeast1（東京）、本番モードで開始する。既に作成済みなら変更しない。
- 初回管理者はコンソールでメール/パスワードのユーザーを作成し、UIDを控える。Firestore の counterManagers/{uid} に name (string), role (string: admin), enabled (boolean: true) を登録する。公開アプリに管理者を自己登録する機能は付けない。
- メール確認は不要。メール/パスワード認証とコンソールで事前承認された UID・有効な管理権限の両方を確認する。匿名認証は管理者として認めない。
- 検証済みの候補を `firestore.rules` に反映済み。実際の Firebase Console のルールは別途、専用プロジェクトで公開する必要がある。新しいコミットの CI も成功していることを確認する。
- GitHub Pages は Settings → Pages → Source → GitHub Actions を選択し、main の更新時に Deploy independent people counter が自動実行される。公開前に Firebase のルールを適用する。QRプロジェクトの設定・利用者・データは移行しない。
