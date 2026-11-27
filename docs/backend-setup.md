# 独立バックエンド構築
- 専用 Firebase: people-counter-system-aed75。Spark 無料プラン。
- Authentication の匿名認証を有効にする。管理アプリ・計測アプリは別の Firebase App 名で端末の認証状態を分離する。
- 管理アプリを通常の Safari で開き、未承認画面の端末UIDを確認する。UIDはブラウザの認証保存領域に依存し、データ消去やプライベートブラウズでは変わりうる。
- 信頼できる管理者が Firebase Console で Authentication の匿名ユーザーとUIDを照合し、Firestore の counterManagers/{uid} に name (string), role (admin または subAdmin), enabled (boolean: true) を設定する。UIDの申告だけで承認せず、実際の管理端末上の表示を確認する。
- メール/パスワードの旧アカウントや権限文書は自動削除しないが、新方式では使用できない。不要なら新端末の承認成功後、コンソールで無効化する。
- 端末の紛失・交換時は enabled を false にして旧UIDを失効させ、新UIDを別途承認する。ログイン操作は不要、管理画面のロックはUIDを維持する。
- CI 成功を確認してから firestore.rules を専用 Firebase Console で公開する。GitHub Pages は main 更新時にテスト後自動公開する。既存QRシステムは変更しない。
