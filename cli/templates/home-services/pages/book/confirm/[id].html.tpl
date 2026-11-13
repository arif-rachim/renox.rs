<r-layout use="portal">
  <r-group slot="title"><r-t key="book.confirm.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="book.confirm.title" /></h1>
  <p><r-t key="book.confirm.intro" /></p>
  <dl id="draft-summary">
    <dt><r-t key="book.f.service" /></dt><dd>{{ draft.service }}</dd>
    <dt><r-t key="book.f.place" /></dt><dd>{{ draft.address }}, {{ draft.area }}, {{ draft.emirate }}</dd>
    <dt><r-t key="book.f.time" /></dt><dd><span dir="ltr">{{ draft.day }}</span> <span dir="ltr">{{ draft.from }}–{{ draft.to }}</span></dd>
    <dt><r-t key="book.f.name" /></dt><dd>{{ draft.name }}</dd>
    <dt><r-t key="book.f.phone" /></dt><dd><span dir="ltr">{{ draft.phone }}</span></dd>
  </dl>
  <x-form action="confirm" class="stack narrow">
    <p><button type="submit" class="btn-brand"><r-t key="book.confirm.submit" /></button></p>
  </x-form>
</r-layout>
