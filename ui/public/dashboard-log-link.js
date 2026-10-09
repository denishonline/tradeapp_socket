"use strict"

const captureLogLink = document.querySelector("#capture-log-link")

function moveLinkBesideCandleStatus() {
  if (!captureLogLink) return
  const candidates = [...document.querySelectorAll("body *")]
    .filter(
      (element) =>
        element !== captureLogLink &&
        element.textContent?.includes("Stock candles - 1 min"),
    )
    .sort((left, right) => left.textContent.length - right.textContent.length)
  const candleStatusLabel = candidates[0]
  if (!candleStatusLabel) return

  let candleStatusBox = candleStatusLabel
  while (
    candleStatusBox.parentElement &&
    candleStatusBox.parentElement !== document.body
  ) {
    const siblings = [...candleStatusBox.parentElement.children]
    const hasServerBox = siblings.some((element) =>
      /(^|\s)Server(\s|$)/i.test(element.textContent || ""),
    )
    const hasDepthBox = siblings.some((element) =>
      element.textContent?.includes("Market depth"),
    )
    if (hasServerBox && hasDepthBox) break
    candleStatusBox = candleStatusBox.parentElement
  }

  const template = candleStatusBox.cloneNode(true)
  template
    .querySelectorAll("[id], [data-status], [aria-live]")
    .forEach((element) => {
      element.removeAttribute("id")
      element.removeAttribute("data-status")
      element.removeAttribute("aria-live")
    })
  template.querySelectorAll("*").forEach((element) => {
    if (!element.children.length && !element.textContent.trim())
      element.remove()
  })
  const textElements = [...template.querySelectorAll("*")].filter(
    (element) => element.children.length === 0 && element.textContent.trim(),
  )
  const label = textElements.find((element) =>
    element.textContent.includes("Stock candles - 1 min"),
  )
  if (label) label.textContent = "Logs"
  else template.textContent = "Logs"
  for (const element of textElements) {
    if (element !== label) element.textContent = "Open ↗"
  }

  captureLogLink.className = candleStatusBox.className
  captureLogLink.classList.add("capture-log-status-link")
  captureLogLink.replaceChildren(...template.childNodes)
  captureLogLink.style.cssText = ""
  const computed = getComputedStyle(candleStatusBox)
  const copiedProperties = [
    "display",
    "box-sizing",
    "min-width",
    "min-height",
    "padding",
    "gap",
    "flex-direction",
    "grid-template-columns",
    "grid-template-rows",
    "align-items",
    "justify-content",
    "border",
    "border-radius",
    "background",
    "box-shadow",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
  ]
  for (const property of copiedProperties) {
    captureLogLink.style.setProperty(
      property,
      computed.getPropertyValue(property),
    )
  }
  captureLogLink.style.minWidth = "120px"
  captureLogLink.style.width = "fit-content"
  captureLogLink.style.padding = "1px 5px"
  captureLogLink.style.textDecoration = "none"
  captureLogLink.style.cursor = "pointer"
  candleStatusBox.insertAdjacentElement("afterend", captureLogLink)
}

moveLinkBesideCandleStatus()

captureLogLink?.addEventListener("click", (event) => {
  const popup = window.open(
    captureLogLink.href,
    "tradeapp-capture-logs",
    "popup=yes,width=1400,height=900,resizable=yes,scrollbars=yes",
  )
  if (popup) {
    event.preventDefault()
    popup.focus()
  }
})
