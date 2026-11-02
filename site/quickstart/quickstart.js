(function () {
  var status = document.getElementById("copy-status");

  function announce(message) {
    if (status) {
      status.textContent = message;
    }
  }

  document.querySelectorAll(".code-copy").forEach(function (button) {
    button.removeAttribute("hidden");
    button.addEventListener("click", function () {
      var targetId = button.getAttribute("data-copy-for");
      var block = targetId ? document.getElementById(targetId) : null;
      if (!block) {
        announce("Copy failed; select the text instead.");
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
            announce("Copy failed; select the text instead.");
          }
        );
        return;
      }
      var range = document.createRange();
      range.selectNodeContents(block);
      var selection = window.getSelection();
      if (!selection) {
        announce("Copy failed; select the text instead.");
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      var copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (_err) {
        copied = false;
      }
      selection.removeAllRanges();
      if (copied) {
        announce("Copied to clipboard");
        button.textContent = "Copied";
        window.setTimeout(function () {
          button.textContent = "Copy";
        }, 2000);
      } else {
        announce("Copy failed; select the text instead.");
      }
    });
  });
})();
