<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>{{ number }}</title>
  <style>
    body { font-family: "Noto Naskh Arabic", "Noto Sans", sans-serif; font-size: 12pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 12pt; }
    th { text-align: right; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: left; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <h1>عرض سعر {{ number }}</h1>
  <p>التاريخ: {{ created_at }} · صالح حتى: {{ valid_until }}</p>
  <p><strong>{{ customer.name }}</strong><br>
    <span r-if="customer.trn">الرقم الضريبي: {{ customer.trn }}<br></span>
    <span dir="ltr">{{ customer.phone }}</span><br>
    <span r-if="site">{{ site.label }}، {{ site.area }}، {{ site.address }}</span></p>
  <table id="lines">
    <thead><tr :style="brand.rule_style"><th>الوصف</th><th class="num">الكمية</th><th class="num">سعر الوحدة (درهم)</th><th class="num">الصافي (درهم)</th><th class="num">الضريبة (درهم)</th><th class="num">الإجمالي (درهم)</th></tr></thead>
    <tbody>
      <tr r-for="l in lines"><td>{{ l.description }}</td><td class="num">{{ l.qty }}</td><td class="num">{{ l.unit_price | number(2) }}</td><td class="num">{{ l.net | number(2) }}</td><td class="num">{{ l.vat | number(2) }} ({{ l.vat_rate }}%)</td><td class="num">{{ l.total | number(2) }}</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td></td><td class="num">المجموع الفرعي</td><td class="num">{{ totals.subtotal | number(2) }}</td></tr>
    <tr><td></td><td class="num">ضريبة القيمة المضافة</td><td class="num">{{ totals.vat | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>الإجمالي (درهم)</strong></td><td class="num"><strong>{{ totals.total | number(2) }}</strong></td></tr>
  </table>
  <p r-if="notes">{{ notes }}</p>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
