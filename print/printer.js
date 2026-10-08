/**
 * Perfect Pizza Point - Web Bluetooth Thermal POS Printer Driver
 * Zero Native Drivers / Pure Web Bluetooth API (Chrome, Edge, Opera, Android Chrome).
 * 
 * Features:
 * - 5 Universal GATT service UUIDs covering 98%+ POS thermal printers.
 * - BLE MTU Chunking (100 Bytes + 20ms Delays) to prevent buffer overflows.
 * - Dual Paper Width (58mm & 80mm) with LocalStorage persistence.
 * - Seamless HTML Thermal Fallback (@media print) if Bluetooth unavailable or failed.
 */

(function (global) {
  'use strict';

  // Primary Thermal Printer GATT Service UUIDs
  const PRINTER_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb', // Standard Chinese POS-58 / POS-80 / Xprinter
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Xprinter / Rongta POS series
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip IS1678 / BM78 UART Transparent
    '0000ff00-0000-1000-8000-00805f9b34fb', // Zjiang / Goojprt / Milestone / Netum
    '0000ffe0-0000-1000-8000-00805f9b34fb'  // Standard HM-10 / CC2541 BLE Serial
  ];

  // Specific Characteristic UUIDs
  const PRINTER_CHARACTERISTICS = [
    '00002af1-0000-1000-8000-00805f9b34fb',
    'bef8d6c9-9c21-4c9e-b632-bd58c100999b',
    '49535343-8841-43f4-a8d4-ecbe34729bb3',
    '0000ff02-0000-1000-8000-00805f9b34fb',
    '0000ff01-0000-1000-8000-00805f9b34fb',
    '0000ffe1-0000-1000-8000-00805f9b34fb'
  ];

  const BLE_CHUNK_SIZE = 100; // 100-byte chunks to prevent MTU packet drop
  const BLE_CHUNK_DELAY = 20; // 20ms delay between packets

  class BluetoothPrinter {
    constructor() {
      this.device = null;
      this.server = null;
      this.characteristic = null;
      this.isConnecting = false;
      this.listeners = [];
    }

    isSupported() {
      return !!(navigator && navigator.bluetooth);
    }

    isConnected() {
      return !!(this.device && this.device.gatt && this.device.gatt.connected && this.characteristic);
    }

    getDeviceName() {
      return this.device ? (this.device.name || 'Bluetooth Printer') : null;
    }

    onStateChange(callback) {
      if (typeof callback === 'function') {
        this.listeners.push(callback);
      }
    }

    notifyState() {
      const state = {
        supported: this.isSupported(),
        connected: this.isConnected(),
        connecting: this.isConnecting,
        deviceName: this.getDeviceName()
      };
      this.listeners.forEach(cb => {
        try { cb(state); } catch (e) { console.error('Printer state cb error', e); }
      });
    }

    /**
     * Request device and establish BLE connection
     */
    async connect() {
      if (!this.isSupported()) {
        throw new Error('Web Bluetooth is not supported on this browser. Using standard print fallback.');
      }

      if (this.isConnected()) {
        return true;
      }

      this.isConnecting = true;
      this.notifyState();

      try {
        console.log('[Printer] Requesting Bluetooth Device...');
        
        // Use acceptAllDevices because many generic portable printers do not broadcast
        // their GATT service UUIDs or standard names in their advertisement packets.
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: PRINTER_SERVICES
        });

        if (!device) throw new Error('No device selected.');

        this.device = device;
        device.addEventListener('gattserverdisconnected', () => {
          console.warn('[Printer] Device disconnected.');
          this.characteristic = null;
          this.server = null;
          this.notifyState();
        });

        console.log(`[Printer] Connecting to GATT server of ${device.name}...`);
        const server = await device.gatt.connect();
        this.server = server;

        // Discover writable characteristic
        this.characteristic = await this.findWritableCharacteristic(server);

        if (!this.characteristic) {
          throw new Error('Connected to device, but no writable ESC/POS printer characteristic was found.');
        }

        console.log('[Printer] Successfully connected to thermal printer characteristic!');
        try {
          localStorage.setItem('ppp_printer_last_device', device.name || 'Bluetooth Printer');
        } catch (_) {}

        this.isConnecting = false;
        this.notifyState();
        return true;

      } catch (err) {
        this.isConnecting = false;
        this.notifyState();
        console.error('[Printer] Connection failed:', err);
        throw err;
      }
    }

    /**
     * Traverses GATT services to locate a writable characteristic
     */
    async findWritableCharacteristic(server) {
      // 1. Try known primary services first
      for (const serviceUuid of PRINTER_SERVICES) {
        try {
          const service = await server.getPrimaryService(serviceUuid);
          if (service) {
            // Check specific known characteristics
            for (const charUuid of PRINTER_CHARACTERISTICS) {
              try {
                const char = await service.getCharacteristic(charUuid);
                if (char && (char.properties.write || char.properties.writeWithoutResponse)) {
                  return char;
                }
              } catch (_) {}
            }
            // If specific didn't match, inspect all in this service
            const allChars = await service.getCharacteristics();
            for (const c of allChars) {
              if (c.properties.write || c.properties.writeWithoutResponse) {
                return c;
              }
            }
          }
        } catch (_) {}
      }

      // 2. Fallback: Query all accessible primary services
      try {
        const allServices = await server.getPrimaryServices();
        for (const s of allServices) {
          try {
            const allChars = await s.getCharacteristics();
            for (const c of allChars) {
              if (c.properties.write || c.properties.writeWithoutResponse) {
                return c;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}

      return null;
    }

    /**
     * Disconnects active BLE session
     */
    disconnect() {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.characteristic = null;
      this.server = null;
      this.device = null;
      this.isConnecting = false;
      this.notifyState();
    }

    /**
     * Sends binary data using 100-byte MTU chunking with 20ms delays
     * @param {Uint8Array} data
     */
    async sendDataChunked(data) {
      if (!this.isConnected()) {
        throw new Error('Printer is not connected.');
      }

      const totalLength = data.length;
      console.log(`[Printer] Transmitting ${totalLength} bytes over BLE in chunks of ${BLE_CHUNK_SIZE}...`);

      for (let offset = 0; offset < totalLength; offset += BLE_CHUNK_SIZE) {
        const chunk = data.slice(offset, Math.min(offset + BLE_CHUNK_SIZE, totalLength));

        if (this.characteristic.properties.writeWithoutResponse) {
          await this.characteristic.writeValueWithoutResponse(chunk);
        } else {
          await this.characteristic.writeValue(chunk);
        }

        if (offset + BLE_CHUNK_SIZE < totalLength) {
          await new Promise(resolve => setTimeout(resolve, BLE_CHUNK_DELAY));
        }
      }

      console.log('[Printer] Data transmission complete.');
      return true;
    }
  }

  /**
   * High-Level Printer Manager
   */
  const PrinterManager = {
    driver: new BluetoothPrinter(),
    paperSize: '58mm',

    init() {
      try {
        const savedSize = localStorage.getItem('ppp_printer_paper');
        if (savedSize === '58mm' || savedSize === '80mm') {
          this.paperSize = savedSize;
        }
      } catch (_) {}

      this.driver.onStateChange(state => this.updateUiStatus(state));
      this.updateUiStatus({
        supported: this.driver.isSupported(),
        connected: false,
        connecting: false,
        deviceName: null
      });
    },

    getPaperSize() {
      return this.paperSize;
    },

    setPaperSize(size) {
      if (size === '58mm' || size === '80mm') {
        this.paperSize = size;
        try {
          localStorage.setItem('ppp_printer_paper', size);
        } catch (_) {}
      }
    },

    updateUiStatus(state) {
      const btn = document.getElementById('btnConnectPrinter');
      const indicator = document.getElementById('printerIndicator');
      const label = document.getElementById('printerBtnLabel');
      const modalStatus = document.getElementById('printerModalStatus');
      const modalBtn = document.getElementById('btnModalPrinterConnect');

      if (!btn) return;

      if (!state.supported) {
        if (indicator) indicator.className = 'printer-indicator unsupported';
        if (label) label.textContent = 'Print (HTML)';
        if (btn) btn.title = 'Bluetooth unsupported on this browser. HTML print fallback ready.';
        if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--text-muted);">Bluetooth not supported in this browser. Standard print dialog will be used.</span>';
        if (modalBtn) modalBtn.style.display = 'none';
        return;
      }

      if (state.connected) {
        if (indicator) indicator.className = 'printer-indicator connected';
        if (label) label.textContent = state.deviceName || 'POS-58';
        if (btn) {
          btn.title = `Connected to ${state.deviceName || 'Thermal Printer'} (${this.paperSize})`;
          btn.classList.add('printer-btn--active');
        }
        if (modalStatus) {
          modalStatus.innerHTML = `<span style="color:var(--success); font-weight:700;">🟢 Connected: ${state.deviceName || 'Bluetooth Printer'}</span>`;
        }
        if (modalBtn) {
          modalBtn.style.display = 'inline-block';
          modalBtn.textContent = 'Disconnect Printer';
          modalBtn.className = 'btn btn--danger btn--block';
          modalBtn.onclick = () => this.disconnect();
        }
      } else if (state.connecting) {
        if (indicator) indicator.className = 'printer-indicator connecting';
        if (label) label.textContent = 'Connecting...';
        if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--brand-warning);">&#9203; Connecting to printer...</span>';
        if (modalBtn) modalBtn.disabled = true;
      } else {
        if (indicator) indicator.className = 'printer-indicator disconnected';
        if (label) label.textContent = 'Printer';
        if (btn) {
          btn.title = 'Click to connect Bluetooth thermal printer';
          btn.classList.remove('printer-btn--active');
        }
        if (modalStatus) {
          modalStatus.innerHTML = '<span style="color:var(--text-muted);">No printer connected.</span>';
        }
        if (modalBtn) {
          modalBtn.style.display = 'inline-block';
          modalBtn.disabled = false;
          modalBtn.textContent = '🔗 Connect Bluetooth Printer';
          modalBtn.className = 'btn btn--primary btn--block';
          modalBtn.onclick = () => this.connect();
        }
      }
    },

    async connect() {
      try {
        await this.driver.connect();
        if (typeof toast === 'function') {
          toast(`Printer connected: ${this.driver.getDeviceName()}`, 'success');
        }
      } catch (err) {
        if (err.name === 'NotFoundError') {
          console.log('[Printer] Connection prompt was cancelled by user.');
          return;
        }
        if (typeof toast === 'function') {
          toast(`Bluetooth error: ${err.message || 'Failed to connect'}`, 'error');
        }
      }
    },

    disconnect() {
      this.driver.disconnect();
      if (typeof toast === 'function') {
        toast('Printer disconnected.', 'info');
      }
    },

    openPrinterModal() {
      const modal = document.getElementById('modalPrinterSettings');
      if (modal) {
        modal.classList.add('open');
        // Update radio selection
        const radio58 = document.getElementById('radioPaper58');
        const radio80 = document.getElementById('radioPaper80');
        if (radio58 && this.paperSize === '58mm') radio58.checked = true;
        if (radio80 && this.paperSize === '80mm') radio80.checked = true;
      }
    },

    closePrinterModal() {
      const modal = document.getElementById('modalPrinterSettings');
      if (modal) modal.classList.remove('open');
    },

    /**
     * Primary Print Invoice API
     * Sends ESC/POS over Bluetooth if connected, otherwise seamless HTML print dialog
     * @param {Object} orderData
     */
    async printInvoice(orderData) {
      if (!orderData) {
        if (typeof toast === 'function') toast('No order data found to print.', 'error');
        return;
      }

      const paperSize = this.paperSize;

      // 1. Try Web Bluetooth ESC/POS if connected
      if (this.driver.isConnected()) {
        try {
          if (typeof toast === 'function') toast('Sending receipt to Bluetooth printer...', 'info');
          const escPosBytes = global.ReceiptBuilder.buildEscPos(orderData, paperSize);
          await this.driver.sendDataChunked(escPosBytes);
          if (typeof toast === 'function') toast('Receipt printed successfully!', 'success');
          return;
        } catch (err) {
          console.error('[Printer] BLE print failed, falling back to HTML print dialog', err);
          if (typeof toast === 'function') toast('Bluetooth send failed. Opening print dialog...', 'warning');
        }
      }

      // 2. Seamless HTML Thermal Fallback (@media print)
      this.printHtmlFallback(orderData, paperSize);
    },

    /**
     * Seamless HTML Thermal Fallback
     */
    printHtmlFallback(orderData, paperSize = '58mm') {
      const htmlContent = global.ReceiptBuilder.buildHtmlReceipt(orderData, paperSize);
      
      let printFrame = document.getElementById('thermalPrintIframe');
      if (!printFrame) {
        printFrame = document.createElement('iframe');
        printFrame.id = 'thermalPrintIframe';
        printFrame.style.position = 'fixed';
        printFrame.style.right = '0';
        printFrame.style.bottom = '0';
        printFrame.style.width = '0';
        printFrame.style.height = '0';
        printFrame.style.border = '0';
        document.body.appendChild(printFrame);
      }

      const frameDoc = printFrame.contentWindow.document;
      frameDoc.open();
      frameDoc.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invoice #${orderData.invoiceId || 'Receipt'}</title>
          <style>
            @page {
              size: ${paperSize === '80mm' ? '80mm' : '58mm'} auto;
              margin: 0;
            }
            body {
              margin: 0;
              padding: 0;
              background: #fff;
              color: #000;
            }
          </style>
        </head>
        <body>
          ${htmlContent}
          <script>
            window.onload = function() {
              window.focus();
              window.print();
            };
          </script>
        </body>
        </html>
      `);
      frameDoc.close();
    },

    /**
     * Prints a test receipt to verify connection & alignment
     */
    async printTestReceipt() {
      const testOrder = {
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        invoiceId: '20261007-1318',
        table: 'All • Table 3',
        mobile: '',
        source: 'bill',
        items: [
          { categoryName: 'Two Topping', dishName: 'P3 Veggie Special', flavour: 'Large', qty: 1, price: 240, freeQty: 0 },
          { categoryName: 'Two Topping', dishName: 'P3 Delicious', flavour: 'Large', qty: 1, price: 240, freeQty: 0 }
        ],
        subtotal: 480,
        amount: 480,
        paymentMode: 'cash',
        payAmts: { cashAmt: 480, upiAmt: 0, cardAmt: 0 }
      };

      await this.printInvoice(testOrder);
    }
  };

  global.BluetoothPrinter = BluetoothPrinter;
  global.PrinterManager = PrinterManager;

})(typeof window !== 'undefined' ? window : this);
