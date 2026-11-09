<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>{{ number }}</title>
  <style>
    body { font-family: "Noto Naskh Arabic", "Noto Sans", sans-serif; font-size: 12pt; color: #1b1b1b; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    h2 { font-size: 14pt; margin: 14pt 0 4pt; }
    .brand { font-weight: bold; font-size: 14pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 8pt; }
    th { text-align: right; padding: 4pt; }
    td { padding: 4pt; border-bottom: 0.5pt solid #ccc; }
    .num { text-align: left; }
    .totals td { border: 0; }
    .muted { color: #666; font-size: 9pt; }
  </style>
</head>
<body>
  <p class="brand" :style="brand.text_style">{{ brand.name }}</p>
  <h1>عقد صيانة سنوي {{ number }}</h1>
  <p>المدة: من {{ starts_on }} إلى {{ ends_on }}</p>
  <table>
    <tr>
      <td><strong>العميل</strong><br>{{ customer.name }}<br><span r-if="customer.trn">الرقم الضريبي: {{ customer.trn }}<br></span>{{ customer.phone }}</td>
      <td><strong>الزيارات</strong><br>{{ total_visits }} زيارة مخططة في السنة</td>
    </tr>
  </table>
  <h2>الخدمات والمواقع</h2>
  <table id="items">
    <thead><tr :style="brand.rule_style"><th>الخدمة</th><th>الموقع</th><th class="num">الزيارات في السنة</th></tr></thead>
    <tbody>
      <tr r-for="i in items"><td>{{ i.service }}</td><td>{{ i.site }}<br><span class="muted">{{ i.address }}</span></td><td class="num">{{ i.visits_per_year }}</td></tr>
    </tbody>
  </table>
  <h2>السعر</h2>
  <table class="totals">
    <tr><td></td><td class="num">السعر السنوي</td><td class="num">{{ price | number(2) }}</td></tr>
    <tr><td></td><td class="num">ضريبة القيمة المضافة 5 %</td><td class="num">{{ vat | number(2) }}</td></tr>
    <tr><td></td><td class="num"><strong>الإجمالي (درهم)</strong></td><td class="num"><strong>{{ total | number(2) }}</strong></td></tr>
  </table>
  <p r-if="has_notes">{{ notes }}</p>
  <p class="muted">يُفوتر السعر السنوي مقدماً. تُحدَّد كل زيارة مع العميل مسبقاً. نذكّركم قبل 30 يوماً من انتهاء العقد.</p>
  <p class="muted">{{ brand.footer }}</p>
</body>
</html>
