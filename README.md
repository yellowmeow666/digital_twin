# digital_twin

数字孪生 MVP：浏览器里打开的静态演示页，用 Three.js（CDN）渲染场景，点选物体后在侧栏查看信息。

## 技术栈

- 纯静态页面（HTML / CSS / JavaScript）
- Three.js 通过 CDN 引入
- **不需要** npm、Node、Docker 或任何构建步骤

## 本地运行

```bash
git clone https://github.com/yellowmeow666/digital_twin.git
cd digital_twin
git checkout feat/digital-twin-mvp
python3 -m http.server 8080
```

浏览器打开 [http://localhost:8080](http://localhost:8080)。

## 怎么演示

1. 打开页面后会看到三维场景。
2. 用鼠标点选场景里的物体。
3. 侧栏会显示当前选中对象的信息。

## 协作说明

开发共用分支：`feat/digital-twin-mvp`。推送前请先 `git pull --rebase`，不要 force push，不要直接推 `main`。
