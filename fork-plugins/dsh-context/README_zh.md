# dsh-context 中文说明

上游 v0.87.2 起中文文档与英文文档分文件维护：[`README.md`](README.md) 是简体中文版，[`README_en.md`](README_en.md) 是英文版，其余语言见同目录的 `README_<locale>.md`。

本文件只为 fork 的隔离构建保留：`scripts/fork-plugins-build.ts` 的 context 插件 `workCopy` 列表仍引用 `README_zh.md`，缺少该文件会让 staging 以 “cannot build from source” 失败。上游若重新引入同名文件，可让上位者替换本文件。
