(function () {
  var status = document.getElementById("copy-status");

  function announce(message) {
    if (status) {
      status.textContent = message;
    }
  }

  document.querySelectorAll(".code-copy").forEach(function (button) {
    button.addEventListener("click", function () {
      var targetId = button.getAttribute("data-copy-for");
      var block = targetId ? document.getElementById(targetId) : null;
      if (!block) {
        return;
      }
      var text = block.textContent || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            announce("Copied to clipboard");
            button.textContent = "Copied";
            window.setTimeout(function () {
              button.textContent = "Copy";
            }, 2000);
          },
          function () {
            announce("Copy failed");
          }
        );
        return;
      }
      var range = document.createRange();
      range.selectNodeContents(block);
      var selection = window.getSelection();
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        document.execCommand("copy");
        announce("Copied to clipboard");
      } catch (_err) {
        announce("Copy failed");
      }
      selection.removeAllRanges();
    });
  });
})();
