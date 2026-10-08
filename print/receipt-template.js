/**
 * Perfect Pizza Point - Receipt Template & ESC/POS Generator
 * Supports 58mm (32 columns) & 80mm (48 columns) thermal printers.
 * Handles all 16 billing variations (Phone ±, Min ±, Same-Day ±, Loyalty ±).
 * 
 * Redesigned Layout:
 * - Clearly numbered dishes (1., 2., 3.).
 * - Line 1: Main dish name and flavour across full receipt width.
 * - Line 2: Category, Quantity, and Amount underneath.
 * - Clean dashed separator between multi-item orders.
 * - Formatted Date (DD-MM-YYYY) and 12-Hour AM/PM time.
 * - Dual paper width (58mm and 80mm) with matching HTML print fallback.
 */

(function (global) {
  'use strict';

  // ESC/POS Command Byte Sequences
  const ESC = 0x1B;
  const GS = 0x1D;

  const CMD = {
    INIT: [ESC, 0x40],
    ALIGN_LEFT: [ESC, 0x61, 0x00],
    ALIGN_CENTER: [ESC, 0x61, 0x01],
    ALIGN_RIGHT: [ESC, 0x61, 0x02],
    BOLD_ON: [ESC, 0x45, 0x01],
    BOLD_OFF: [ESC, 0x45, 0x00],
    DOUBLE_SIZE: [GS, 0x21, 0x11],
    DOUBLE_HEIGHT: [GS, 0x21, 0x01],
    NORMAL_SIZE: [GS, 0x21, 0x00],
    FEED_LINE: [0x0A],
    FEED_2_LINES: [0x0A, 0x0A],
    CUT_PAPER: [GS, 0x56, 0x42, 0x00] // Partial cut with feed
  };

  /** Text helper utilities */
  function padRight(str, len) {
    str = String(str || '');
    if (str.length >= len) return str.slice(0, len);
    return str + ' '.repeat(len - str.length);
  }

  function padLeft(str, len) {
    str = String(str || '');
    if (str.length >= len) return str.slice(0, len);
    return ' '.repeat(len - str.length) + str;
  }

  function formatTwoCols(left, right, width) {
    left = String(left || '');
    right = String(right || '');
    const spaceNeeded = width - left.length - right.length;
    if (spaceNeeded < 1) {
      const maxLeft = Math.max(1, width - right.length - 1);
      return left.slice(0, maxLeft) + ' ' + right;
    }
    return left + ' '.repeat(spaceNeeded) + right;
  }

  function divider(width, char = '-') {
    return char.repeat(width);
  }

  /**
   * Converts date to DD-MM-YYYY
   */
  function formatDateDmy(dateStr) {
    if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const parts = dateStr.split('-');
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(dateStr)) {
      return dateStr.replace(/\//g, '-');
    }
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
      }
    } catch (_) {}
    return dateStr;
  }

  /**
   * Converts time to 12-hour AM/PM format (e.g. 01:18 PM)
   */
  function formatTimeAmPm(timeStr) {
    if (!timeStr) {
      return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    if (/am|pm/i.test(timeStr)) {
      return timeStr.toUpperCase();
    }
    const match = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = match[2];
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hh = String(hours).padStart(2, '0');
      return `${hh}:${minutes} ${ampm}`;
    }
    return timeStr;
  }

  /**
   * Wraps text into lines that do not exceed maxWidth, breaking only on spaces.
   */
  function wrapText(text, maxWidth) {
    if (!text) return [];
    text = String(text).trim().replace(/\s+/g, ' ');
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!currentLine) {
        if (word.length <= maxWidth) {
          currentLine = word;
        } else {
          for (let j = 0; j < word.length; j += maxWidth) {
            const chunk = word.slice(j, j + maxWidth);
            if (chunk.length === maxWidth) lines.push(chunk);
            else currentLine = chunk;
          }
        }
      } else {
        if (currentLine.length + 1 + word.length <= maxWidth) {
          currentLine += ' ' + word;
        } else {
          lines.push(currentLine);
          if (word.length <= maxWidth) {
            currentLine = word;
          } else {
            currentLine = '';
            for (let j = 0; j < word.length; j += maxWidth) {
              const chunk = word.slice(j, j + maxWidth);
              if (chunk.length === maxWidth) lines.push(chunk);
              else currentLine = chunk;
            }
          }
        }
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  /**
   * Returns clean dish name with flavour attached
   */
  function cleanDishWithFlavour(item) {
    let dish = String(item.dishName || item.name || 'Item').trim();
    let flavour = String(item.flavour || '').trim();

    if (flavour) {
      const escaped = flavour.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const reg = new RegExp(`\\(?\\b${escaped}\\b\\)?`, 'i');
      if (!reg.test(dish)) {
        dish = `${dish} (${flavour})`;
      }
    }
    return dish;
  }

  /**
   * Resolves clean category name for an item
   */
  function cleanCategoryName(item) {
    let category = String(item.categoryName || '').trim();
    if (category.toLowerCase() === 'unknown') category = '';
    if (!category && typeof global.lookupCategoryForDish === 'function') {
      category = global.lookupCategoryForDish(item.dishName || item.name) || '';
    }
    return category || 'Specialty';
  }

  function textToBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code === 0x20B9) {
        bytes.push(0x52, 0x73, 0x2E); // "Rs."
      } else if (code > 127) {
        bytes.push(0x20); // space for non-ASCII
      } else {
        bytes.push(code);
      }
    }
    return bytes;
  }

  /**
   * ReceiptBuilder Object
   */
  const ReceiptBuilder = {
    cleanDishWithFlavour,
    cleanCategoryName,
    formatDateDmy,
    formatTimeAmPm,
    wrapText,

    /**
     * Builds ESC/POS binary Uint8Array buffer
     * @param {Object} order
     * @param {'58mm'|'80mm'} paperSize
     * @returns {Uint8Array}
     */
    buildEscPos(order, paperSize = '58mm') {
      const cols = (paperSize === '80mm') ? 48 : 32;
      const is80mm = (paperSize === '80mm');
      const buffer = [];

      function pushCmd(cmdArray) {
        buffer.push(...cmdArray);
      }

      function pushLine(text = '') {
        buffer.push(...textToBytes(text));
        buffer.push(0x0A);
      }

      // Initialize Printer
      pushCmd(CMD.INIT);

      // Top Double Divider
      pushLine(divider(cols, '='));

      // Header: Store Name & Phone
      pushCmd(CMD.ALIGN_CENTER);
      pushCmd(CMD.BOLD_ON);
      pushCmd(CMD.DOUBLE_HEIGHT);
      pushLine('PERFECT PIZZA POINT');
      pushCmd(CMD.NORMAL_SIZE);
      pushCmd(CMD.BOLD_OFF);
      pushLine('Ph: +91 8319798869');
      pushLine(divider(cols, '-'));

      // Metadata Header
      pushCmd(CMD.ALIGN_LEFT);
      const dateFormatted = formatDateDmy(order.date);
      const timeFormatted = formatTimeAmPm(order.time);
      pushLine(formatTwoCols(`Date: ${dateFormatted}`, timeFormatted, cols));

      const tableText = (order.tableInfo && order.tableInfo.tableName) 
        ? `${order.tableInfo.sectionName || 'Table'} • ${order.tableInfo.tableName}`
        : (order.table || 'Takeaway');
      const tableLines = wrapText(`Table: ${tableText}`, cols);
      tableLines.forEach(l => pushLine(l));

      const customerText = (order.mobile && order.mobile.trim() && order.mobile !== 'Anonymous')
        ? `+91 ${order.mobile.replace(/\D/g, '').slice(-10)}`
        : 'Walk-in Guest';
      const custType = order.source === 'entry' ? '[LOYALTY]' : '[RETAIL]';
      const custLines = wrapText(`Cust: ${customerText} ${custType}`, cols);
      custLines.forEach(l => pushLine(l));

      pushLine(divider(cols, '-'));

      // Items Section
      pushCmd(CMD.BOLD_ON);
      if (is80mm) {
        // 80mm Header (48 cols): #  ITEM & DETAILS (36) | QTY (5) | AMT (7)
        pushLine('#  ITEM & DETAILS                   QTY      AMT');
      } else {
        // 58mm Header (32 cols): ITEM (21) | QTY (5) | AMT (6)
        pushLine('ITEM                 QTY     AMT');
      }
      pushCmd(CMD.BOLD_OFF);
      pushLine(divider(cols, '-'));

      const items = Array.isArray(order.items) ? order.items : [];
      let calculatedSubtotal = 0;

      items.forEach((item, idx) => {
        const itemNumber = `${idx + 1}. `;
        const dishWithFlavour = cleanDishWithFlavour(item);
        const category = cleanCategoryName(item);
        const qty = Number(item.qty) || 1;
        const price = Number(item.price) || 0;
        const itemTotal = Math.round(qty * price);
        calculatedSubtotal += itemTotal;

        if (is80mm) {
          // ── 80mm 2-Line Layout (48 cols) ──
          const line1Text = `${itemNumber}${dishWithFlavour}`;
          if (line1Text.length <= 37) {
            pushLine(padRight(line1Text, 37) + padLeft(String(qty), 2) + padLeft(String(itemTotal), 9));
            pushLine(`   Category: ${category}`);
          } else {
            // Long title: print full title across width, details on line 2
            const wrappedTitle = wrapText(line1Text, cols);
            wrappedTitle.forEach(l => pushLine(l));
            pushLine(padRight(`   Category: ${category}`, 37) + padLeft(String(qty), 2) + padLeft(String(itemTotal), 9));
          }

          if (item.freeQty && item.freeQty > 0) {
            pushLine(`   * Incl. ${item.freeQty} Free Reward`);
          }

          if (idx < items.length - 1) {
            pushLine(divider(cols, '-'));
          }

        } else {
          // ── 58mm 2-Line Layout (32 cols) ──
          // Line 1: Main dish name across the full 32-col width
          const line1Title = `${itemNumber}${dishWithFlavour}`;
          const titleLines = wrapText(line1Title, cols);
          titleLines.forEach(l => pushLine(l));

          // Line 2: Indented Category (22 chars), QTY (2 chars), AMT (8 chars) = 32 chars
          const categoryCol = padRight(`   ${category}`, 22);
          const qtyCol = padLeft(String(qty), 2);
          const amtCol = padLeft(String(itemTotal), 8);
          pushLine(categoryCol + qtyCol + amtCol);

          if (item.freeQty && item.freeQty > 0) {
            pushLine(`   * Incl. ${item.freeQty} Free Reward`);
          }

          // Separator between items: clean dotted/dashed separator
          if (idx < items.length - 1) {
            pushLine(' - - - - - - - - - - - - - - - -');
          }
        }
      });

      if (items.length === 0) {
        const fallbackAmt = Math.round(Number(order.subtotal || order.amount || 0));
        pushLine(formatTwoCols('1. Order Items', `Rs. ${fallbackAmt}`, cols));
        calculatedSubtotal = fallbackAmt;
      }

      pushLine(divider(cols, '-'));

      // Financials (Strict whole integers)
      const subtotal = Math.round(Number(order.subtotal !== undefined ? order.subtotal : calculatedSubtotal) || 0);
      const taxAmt = Math.round(Number(order.taxAmt) || 0);
      const discountAmt = Math.round(Number(order.discountAmt) || 0);

      if (taxAmt > 0 || discountAmt > 0) {
        pushLine(formatTwoCols('Subtotal:', `Rs. ${subtotal}`, cols));
        if (taxAmt > 0) {
          const taxLabel = order.taxPct ? `Tax (${order.taxPct}%):` : 'Tax:';
          pushLine(formatTwoCols(taxLabel, `Rs. ${taxAmt}`, cols));
        }
        if (discountAmt > 0) {
          pushLine(formatTwoCols('Discount:', `-Rs. ${discountAmt}`, cols));
        }
        pushLine(divider(cols, '-'));
      }

      // Grand Total
      const grandTotal = Math.round(Number(order.amount !== undefined ? order.amount : (subtotal + taxAmt - discountAmt)));
      pushCmd(CMD.BOLD_ON);
      pushLine(formatTwoCols('TOTAL:', `Rs. ${grandTotal}`, cols));
      pushCmd(CMD.BOLD_OFF);

      // Payment Breakdown
      const mode = (order.paymentMode || 'cash').toUpperCase();
      const isSplit = mode === 'SPLIT' || (order.payAmts && ((order.payAmts.cashAmt > 0 ? 1 : 0) + (order.payAmts.upiAmt > 0 ? 1 : 0) + (order.payAmts.cardAmt > 0 ? 1 : 0) > 1));

      if (isSplit) {
        pushLine(formatTwoCols('Payment:', 'SPLIT', cols));
        if (order.payAmts) {
          const cashAmt = Math.round(Number(order.payAmts.cashAmt) || 0);
          const upiAmt = Math.round(Number(order.payAmts.upiAmt) || 0);
          const cardAmt = Math.round(Number(order.payAmts.cardAmt) || 0);
          if (cashAmt > 0) pushLine(formatTwoCols('  Cash:', `Rs. ${cashAmt}`, cols));
          if (upiAmt > 0) pushLine(formatTwoCols('  UPI:', `Rs. ${upiAmt}`, cols));
          if (cardAmt > 0) pushLine(formatTwoCols('  Card:', `Rs. ${cardAmt}`, cols));
        }
      } else {
        pushLine(formatTwoCols('Payment Mode:', mode, cols));
      }

      // Loyalty Status Section
      const hasMobile = order.mobile && order.mobile.trim() && order.mobile !== 'Anonymous';
      const isLoyaltyVisit = (order.source === 'entry');
      const loyaltyDetails = order.loyaltyDetails || {};

      if (hasMobile) {
        pushLine(divider(cols, '-'));
        pushCmd(CMD.ALIGN_CENTER);

        if (isLoyaltyVisit) {
          const totalEntries = loyaltyDetails.totalEntries || order.numEntries || 1;
          const cycle = loyaltyDetails.cycle || 10;
          pushLine(`*** LOYALTY REWARD ***`);
          pushLine(`Visits: ${totalEntries} / ${cycle}`);
          
          if (loyaltyDetails.eligible || (totalEntries % cycle === 0)) {
            pushCmd(CMD.BOLD_ON);
            pushLine(`Reward Unlocked: Rs.${loyaltyDetails.rewardValue || 150}`);
            pushCmd(CMD.BOLD_OFF);
          } else {
            const needed = cycle - (totalEntries % cycle);
            pushLine(`${needed} more to next reward!`);
          }
        } else {
          if (order.loyaltyReason) pushLine(`[${order.loyaltyReason}]`);
          if (order.currentVisits) pushLine(`Visits: ${order.currentVisits}`);
        }
      }

      // Footer Framed with Double Divider
      pushLine(divider(cols, '='));
      pushCmd(CMD.ALIGN_CENTER);
      const billId = order.invoiceId || (order.date ? order.date.replace(/-/g, '') : '') + '-' + (order.time ? order.time.replace(/:/g, '') : Math.floor(Math.random() * 1000));
      pushLine(`Inv: #${billId}`);
      pushLine('Thank You! Visit Again');
      pushLine(divider(cols, '='));

      // Feed only 2 lines then cut
      pushCmd(CMD.FEED_2_LINES);
      pushCmd(CMD.CUT_PAPER);

      return new Uint8Array(buffer);
    },

    /**
     * Builds styled HTML Receipt for browser print dialog fallback
     * @param {Object} order
     * @param {'58mm'|'80mm'} paperSize
     * @returns {string}
     */
    buildHtmlReceipt(order, paperSize = '58mm') {
      const widthMm = (paperSize === '80mm') ? '80mm' : '58mm';
      const is80mm = (paperSize === '80mm');
      const dateFormatted = formatDateDmy(order.date);
      const timeFormatted = formatTimeAmPm(order.time);
      const billId = order.invoiceId || (order.date ? order.date.replace(/-/g, '') : '') + '-' + (order.time ? order.time.replace(/:/g, '') : Math.floor(Math.random() * 1000));
      const grandTotal = Math.round(Number(order.amount || 0));
      const items = Array.isArray(order.items) ? order.items : [];
      const subtotal = Math.round(Number(order.subtotal !== undefined ? order.subtotal : grandTotal) || 0);
      const taxAmt = Math.round(Number(order.taxAmt) || 0);
      const discountAmt = Math.round(Number(order.discountAmt) || 0);

      const customerText = (order.mobile && order.mobile.trim() && order.mobile !== 'Anonymous')
        ? `+91 ${order.mobile.replace(/\D/g, '').slice(-10)}`
        : 'Walk-in Guest';

      const tableText = (order.tableInfo && order.tableInfo.tableName)
        ? `${order.tableInfo.sectionName || 'Table'} • ${order.tableInfo.tableName}`
        : (order.table || 'Takeaway');

      let itemsHtml = items.map((item, idx) => {
        const itemNumber = `${idx + 1}. `;
        const dishWithFlavour = cleanDishWithFlavour(item);
        const category = cleanCategoryName(item);
        const qty = Number(item.qty) || 1;
        const price = Number(item.price) || 0;
        const itemTotal = Math.round(qty * price);
        let giftHtml = '';
        if (item.freeQty && item.freeQty > 0) {
          giftHtml = `<div style="font-size: 10px; color: #555; padding-left: 14px;">&bull; Incl. ${item.freeQty} Free Reward</div>`;
        }

        const separatorHtml = (idx < items.length - 1)
          ? `<div style="border-top: 1px dashed #bbb; margin: 4px 0;"></div>`
          : '';

        return `
          <div style="margin-bottom: 4px;">
            <div style="font-weight: 700; font-size: 12px; color: #000;">
              ${itemNumber}${dishWithFlavour}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding-left: 12px; color: #222;">
              <span style="color: #444; font-size: 10.5px;">${category}</span>
              <div style="display: flex; gap: 18px;">
                <span style="font-weight: 600; min-width: 20px; text-align: center;">${qty}</span>
                <span style="font-weight: 600; min-width: 38px; text-align: right;">${itemTotal}</span>
              </div>
            </div>
            ${giftHtml}
            ${separatorHtml}
          </div>
        `;
      }).join('');

      let loyaltySectionHtml = '';
      const hasMobile = order.mobile && order.mobile.trim() && order.mobile !== 'Anonymous';
      const isLoyaltyVisit = (order.source === 'entry');
      const loyaltyDetails = order.loyaltyDetails || {};

      if (hasMobile) {
        if (isLoyaltyVisit) {
          const totalEntries = loyaltyDetails.totalEntries || order.numEntries || 1;
          const cycle = loyaltyDetails.cycle || 10;
          const isEligible = loyaltyDetails.eligible || (totalEntries % cycle === 0);
          loyaltySectionHtml = `
            <div style="border-top: 1px dashed #000; margin: 5px 0; padding: 4px 0; text-align: center;">
              <div style="font-weight: bold; font-size: 12px;">*** LOYALTY REWARD ***</div>
              <div>Visits: <strong>${totalEntries}</strong> / ${cycle}</div>
              ${isEligible 
                ? `<div style="font-weight: bold; margin-top: 2px;">Reward Unlocked! (Rs.${loyaltyDetails.rewardValue || 150})</div>` 
                : `<div style="font-size: 11px;">${cycle - (totalEntries % cycle)} more to next reward</div>`}
            </div>
          `;
        } else if (order.loyaltyReason) {
          loyaltySectionHtml = `
            <div style="border-top: 1px dashed #000; margin: 5px 0; padding-top: 4px; text-align: center; font-size: 11px;">
              <div><em>${order.loyaltyReason}</em></div>
            </div>
          `;
        }
      }

      const mode = (order.paymentMode || 'cash').toUpperCase();
      const isSplit = mode === 'SPLIT' || (order.payAmts && ((order.payAmts.cashAmt > 0 ? 1 : 0) + (order.payAmts.upiAmt > 0 ? 1 : 0) + (order.payAmts.cardAmt > 0 ? 1 : 0) > 1));

      return `
        <div class="thermal-receipt" style="width: ${widthMm}; max-width: ${widthMm}; font-family: 'Courier New', Courier, monospace; font-size: 11.5px; line-height: 1.3; color: #000; background: #fff; margin: 0 auto; padding: 4px 6px; box-sizing: border-box;">
          
          <div style="border-top: 2px solid #000; margin-bottom: 4px;"></div>

          <div style="text-align: center; margin-bottom: 4px;">
            <div style="font-size: 15px; font-weight: 800; letter-spacing: 0.5px;">PERFECT PIZZA POINT</div>
            <div style="font-size: 11px;">Ph: +91 8319798869</div>
          </div>
          
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          
          <div style="margin-bottom: 4px;">
            <div style="display: flex; justify-content: space-between;">
              <span>Date: ${dateFormatted}</span>
              <span>${timeFormatted}</span>
            </div>
            <div>Table: ${tableText}</div>
            <div style="display: flex; justify-content: space-between;">
              <span>Cust: ${customerText}</span>
              <span>${order.source === 'entry' ? '[LOYALTY]' : '[RETAIL]'}</span>
            </div>
          </div>
          
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          
          <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 11px; margin-bottom: 3px;">
            <span>${is80mm ? '#  ITEM & DETAILS' : 'ITEM'}</span>
            <div style="display: flex; gap: 18px;">
              <span style="min-width: 20px; text-align: center;">QTY</span>
              <span style="min-width: 38px; text-align: right;">AMT</span>
            </div>
          </div>

          <div style="border-top: 1px dashed #000; margin: 3px 0 6px 0;"></div>

          <div class="receipt-items-container">
            ${itemsHtml}
          </div>
          
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          
          <div>
            ${taxAmt > 0 || discountAmt > 0 ? `
            <div style="display: flex; justify-content: space-between;">
              <span>Subtotal:</span>
              <span>Rs. ${subtotal}</span>
            </div>
            ${taxAmt ? `
            <div style="display: flex; justify-content: space-between;">
              <span>Tax ${order.taxPct ? `(${order.taxPct}%)` : ''}:</span>
              <span>Rs. ${taxAmt}</span>
            </div>` : ''}
            ${discountAmt ? `
            <div style="display: flex; justify-content: space-between;">
              <span>Discount:</span>
              <span>-Rs. ${discountAmt}</span>
            </div>` : ''}
            <div style="border-top: 1px solid #000; margin: 2px 0;"></div>
            ` : ''}
            
            <div style="display: flex; justify-content: space-between; font-size: 13.5px; font-weight: 800; margin: 3px 0;">
              <span>TOTAL:</span>
              <span>Rs. ${grandTotal}</span>
            </div>
            
            ${isSplit ? `
            <div style="display: flex; justify-content: space-between;">
              <span>Payment:</span>
              <span><strong>SPLIT</strong></span>
            </div>
            ${order.payAmts && order.payAmts.cashAmt > 0 ? `<div style="display: flex; justify-content: space-between;"><span>&nbsp;&nbsp;Cash:</span><span>Rs. ${Math.round(order.payAmts.cashAmt)}</span></div>` : ''}
            ${order.payAmts && order.payAmts.upiAmt > 0 ? `<div style="display: flex; justify-content: space-between;"><span>&nbsp;&nbsp;UPI:</span><span>Rs. ${Math.round(order.payAmts.upiAmt)}</span></div>` : ''}
            ${order.payAmts && order.payAmts.cardAmt > 0 ? `<div style="display: flex; justify-content: space-between;"><span>&nbsp;&nbsp;Card:</span><span>Rs. ${Math.round(order.payAmts.cardAmt)}</span></div>` : ''}
            ` : `
            <div style="display: flex; justify-content: space-between;">
              <span>Payment Mode:</span>
              <span><strong>${mode}</strong></span>
            </div>
            `}
          </div>
          
          ${loyaltySectionHtml}
          
          <div style="border-top: 2px solid #000; margin: 6px 0 4px 0;"></div>
          
          <div style="text-align: center; margin-top: 3px;">
            <div style="font-size: 10.5px;">Inv: #${billId}</div>
            <div style="font-weight: 600;">Thank You! Visit Again</div>
          </div>

          <div style="border-top: 2px solid #000; margin-top: 4px;"></div>
        </div>
      `;
    }
  };

  global.ReceiptBuilder = ReceiptBuilder;

})(typeof window !== 'undefined' ? window : this);
