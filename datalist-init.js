// Make datalist inputs show all suggestions on focus
// (extracted from index.html to satisfy CSP script-src 'self')
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('input[list]').forEach(function (input) {
    var _stored = '';
    input.addEventListener('focus', function () {
      _stored = input.value;
      input.value = '';
      setTimeout(function () {
        input.value = _stored;
        input.dispatchEvent(new Event('input'));
      }, 0);
    });
    input.addEventListener('blur', function () {
      _stored = input.value;
    });
  });
});
