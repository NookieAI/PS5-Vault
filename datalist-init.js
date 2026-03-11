// Make datalist inputs show all suggestions on focus
// (extracted from index.html to satisfy CSP script-src 'self')
//
// NOTE: This file is effectively a no-op in the current implementation.
// dropdown-helper.js calls inputEl.removeAttribute('list') on all inputs it covers
// (sourcePath, destPath, FTP fields), so document.querySelectorAll('input[list]')
// below finds zero of those inputs after dropdown-helper.js has run.
// This file is retained in case any future inputs use a native <datalist>
// without being covered by the custom dropdown helper.
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
