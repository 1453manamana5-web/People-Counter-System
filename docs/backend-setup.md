# 独立バックエンド構築（未実施）

- 新しい Firebase プロジェクトを Spark で作成し、Web アプリを追加する。QR 用のプロジェクトは選択しない。
- Email/Password と Anonymous を有効化する。管理アカウントと計測端末は異なる Firebase App 名で認証状態を分離する。
- 初回管理者は Firebase コンソール等の信頼済み操作で作成する。メールの確認を完了し、Firestore の `counterManagers/{uid}` に `name` (string), `role` (`admin`), `enabled` (true) を登録する。クライアントからのロール登録は不可。
- `docs/firestore.candidate.rules` は未検証の移植案。エミュレータで権限境界を検証し、承認されたルールを適用するまで `firestore.rules` の全拒否を維持する。
- `.env.example` の専用変数を設定し、ビルドと実機検証を行う。公開ワークフローは準備完了後に追加する。
