//! macOS side of Bluetooth sync: the Mac advertises a BLE service and
//! publishes an L2CAP channel; the phone connects and the channel's byte
//! stream is handed to the same TLS+HTTP server the LAN uses
//! (`server::serve_connection`). Nothing about pairing, tokens or pinning
//! changes — Bluetooth is only a different pipe.
//!
//! Discovery: the advertisement carries `SERVICE_UUID`. A read-only GATT
//! characteristic (`INFO_CHAR_UUID`) holds the channel's PSM (2 bytes,
//! big-endian) followed by the first 8 bytes of the TLS key fingerprint, so a
//! phone can pick *its* Mac before connecting. The fingerprint is a hint only
//! (like the `fp` TXT record in mDNS); the real check is the TLS pin.
//!
//! The channel is published without Bluetooth-level encryption on purpose:
//! TLS provides the confidentiality and authentication, and this avoids OS
//! pairing prompts.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, Message};
use objc2_core_bluetooth::{
    CBAdvertisementDataLocalNameKey, CBAdvertisementDataServiceUUIDsKey, CBAttributePermissions,
    CBCharacteristic, CBCharacteristicProperties, CBL2CAPChannel, CBL2CAPPSM, CBManagerState,
    CBMutableCharacteristic, CBMutableService, CBPeripheralManager, CBPeripheralManagerDelegate,
    CBService, CBUUID,
};
use objc2_foundation::{
    NSArray, NSBundle, NSData, NSDate, NSDefaultRunLoopMode, NSDictionary, NSError, NSObject,
    NSObjectProtocol, NSRunLoop, NSStreamStatus, NSString,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};

use crate::server::{serve_connection, BtServeCtx};

/// Must match `BluetoothTunnel.kt` on Android.
pub const SERVICE_UUID: &str = "6B0C7F10-3A5D-4E8B-9C1F-7D2A5B9E4C01";
pub const INFO_CHAR_UUID: &str = "6B0C7F11-3A5D-4E8B-9C1F-7D2A5B9E4C01";

/// Phones open one channel per HTTP connection (downloads run in parallel),
/// so a handful are allowed; more are refused rather than queued.
const MAX_CHANNELS: usize = 4;
/// How long the pump thread lets the run loop run between polls of the streams.
const POLL_SLICE_SECS: f64 = 0.005;
const CHUNK: usize = 16 * 1024;

struct Active {
    manager: Retained<CBPeripheralManager>,
    // The manager only holds its delegate weakly.
    _delegate: Retained<BtDelegate>,
}
// Only touched to start/stop; the objects themselves are used on the main queue.
unsafe impl Send for Active {}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static CTX: Mutex<Option<BtServeCtx>> = Mutex::new(None);
static LIMIT: Mutex<Option<Arc<Semaphore>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "VoynixBtPeripheralDelegate"]
    struct BtDelegate;

    unsafe impl NSObjectProtocol for BtDelegate {}

    unsafe impl CBPeripheralManagerDelegate for BtDelegate {
        #[unsafe(method(peripheralManagerDidUpdateState:))]
        fn did_update_state(&self, peripheral: &CBPeripheralManager) {
            let state = unsafe { peripheral.state() };
            if state == CBManagerState::PoweredOn {
                // Plain (unencrypted) channel; TLS rides on top.
                unsafe { peripheral.publishL2CAPChannelWithEncryption(false) };
            } else {
                eprintln!("bluetooth sync: Bluetooth is not powered on / not allowed (state {:?})", state.0);
            }
        }

        #[unsafe(method(peripheralManager:didPublishL2CAPChannel:error:))]
        fn did_publish_channel(
            &self,
            peripheral: &CBPeripheralManager,
            psm: CBL2CAPPSM,
            error: Option<&NSError>,
        ) {
            if let Some(e) = error {
                eprintln!("bluetooth sync: publishing the L2CAP channel failed: {e:?}");
                return;
            }
            let Some(fingerprint) = CTX.lock().unwrap().as_ref().map(|c| c.fingerprint.clone()) else { return };
            unsafe { add_service(peripheral, psm, &fingerprint) };
        }

        #[unsafe(method(peripheralManager:didAddService:error:))]
        fn did_add_service(
            &self,
            peripheral: &CBPeripheralManager,
            _service: &CBService,
            error: Option<&NSError>,
        ) {
            if let Some(e) = error {
                eprintln!("bluetooth sync: adding the GATT service failed: {e:?}");
                return;
            }
            unsafe { start_advertising(peripheral) };
        }

        #[unsafe(method(peripheralManager:didOpenL2CAPChannel:error:))]
        fn did_open_channel(
            &self,
            _peripheral: &CBPeripheralManager,
            channel: Option<&CBL2CAPChannel>,
            error: Option<&NSError>,
        ) {
            if let Some(e) = error {
                eprintln!("bluetooth sync: incoming L2CAP channel failed: {e:?}");
                return;
            }
            let Some(channel) = channel else { return };
            on_channel(channel.retain());
        }
    }
);

unsafe fn add_service(peripheral: &CBPeripheralManager, psm: CBL2CAPPSM, fingerprint: &str) {
    let mut value = psm.to_be_bytes().to_vec();
    value.extend(fingerprint_prefix(fingerprint));
    let data = NSData::with_bytes(&value);

    let service_uuid = CBUUID::UUIDWithString(&NSString::from_str(SERVICE_UUID));
    let char_uuid = CBUUID::UUIDWithString(&NSString::from_str(INFO_CHAR_UUID));
    // A non-nil value makes the characteristic static, answered by the system
    // without a delegate round-trip.
    let characteristic = CBMutableCharacteristic::initWithType_properties_value_permissions(
        CBMutableCharacteristic::alloc(),
        &char_uuid,
        CBCharacteristicProperties::Read,
        Some(&data),
        CBAttributePermissions::Readable,
    );
    let service = CBMutableService::initWithType_primary(CBMutableService::alloc(), &service_uuid, true);
    let characteristic: Retained<CBCharacteristic> = Retained::into_super(characteristic);
    service.setCharacteristics(Some(&NSArray::from_retained_slice(&[characteristic])));
    peripheral.addService(&service);
}

unsafe fn start_advertising(peripheral: &CBPeripheralManager) {
    let service_uuid = CBUUID::UUIDWithString(&NSString::from_str(SERVICE_UUID));
    let uuids: Retained<NSArray<CBUUID>> = NSArray::from_retained_slice(&[service_uuid]);
    let name = NSString::from_str("Voynix");
    let keys: [&NSString; 2] = [CBAdvertisementDataServiceUUIDsKey, CBAdvertisementDataLocalNameKey];
    let values: [Retained<AnyObject>; 2] = [
        Retained::cast_unchecked(uuids),
        Retained::cast_unchecked(name),
    ];
    let dict = NSDictionary::from_retained_objects(&keys, &values);
    peripheral.startAdvertising(Some(&dict));
}

/// First 8 bytes of the (hex) fingerprint; empty if it isn't valid hex.
fn fingerprint_prefix(fingerprint: &str) -> Vec<u8> {
    (0..16)
        .step_by(2)
        .map(|i| fingerprint.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect::<Option<Vec<u8>>>()
        .unwrap_or_default()
}

/// Starts advertising and accepting channels, serving them with `ctx`.
/// Safe to call again (it restarts).
pub fn start(ctx: BtServeCtx) -> Result<(), String> {
    // Without a usage description macOS kills the process on first Bluetooth
    // access. That's the case for the bare `tauri dev` binary.
    let key = NSString::from_str("NSBluetoothAlwaysUsageDescription");
    if NSBundle::mainBundle().objectForInfoDictionaryKey(&key).is_none() {
        return Err("This build has no NSBluetoothAlwaysUsageDescription (Bluetooth sync only works in the built app, not `tauri dev`)".into());
    }
    stop();
    *CTX.lock().unwrap() = Some(ctx);
    *LIMIT.lock().unwrap() = Some(Arc::new(Semaphore::new(MAX_CHANNELS)));
    RUNNING.store(true, Ordering::SeqCst);

    let this = BtDelegate::alloc().set_ivars(());
    let delegate: Retained<BtDelegate> = unsafe { msg_send![super(this), init] };
    let proto: &ProtocolObject<dyn CBPeripheralManagerDelegate> = ProtocolObject::from_ref(&*delegate);
    // `None` queue = the main queue, which Tauri's event loop services.
    let manager = unsafe {
        CBPeripheralManager::initWithDelegate_queue(CBPeripheralManager::alloc(), Some(proto), None)
    };
    *ACTIVE.lock().unwrap() = Some(Active { manager, _delegate: delegate });
    Ok(())
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    if let Some(active) = ACTIVE.lock().unwrap().take() {
        unsafe {
            active.manager.stopAdvertising();
            active.manager.removeAllServices();
        }
    }
    *CTX.lock().unwrap() = None;
    *LIMIT.lock().unwrap() = None;
}

struct SendChannel(Retained<CBL2CAPChannel>);
// The channel is handed to exactly one thread, which is the only one to touch its streams.
unsafe impl Send for SendChannel {}

/// A phone opened a channel: bridge it to a fresh `serve_connection`.
fn on_channel(channel: Retained<CBL2CAPChannel>) {
    if !RUNNING.load(Ordering::SeqCst) {
        return;
    }
    let (Some(ctx), Some(limit)) = (CTX.lock().unwrap().clone(), LIMIT.lock().unwrap().clone()) else { return };
    let Ok(permit) = limit.try_acquire_owned() else {
        eprintln!("bluetooth sync: too many open channels, refusing one");
        return;
    };

    let (client_side, server_side) = tokio::io::duplex(64 * 1024);
    let (mut from_server, mut to_server) = tokio::io::split(client_side);
    // phone -> server: small requests, so an unbounded queue is fine.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    // server -> phone: bounded, so a fast disk read can't outrun slow Bluetooth.
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(16);

    tauri::async_runtime::spawn(serve_connection(server_side, ctx.acceptor, ctx.router, ctx.stop));
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = in_rx.recv().await {
            if to_server.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = to_server.shutdown().await;
    });
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let mut buf = vec![0u8; CHUNK];
        loop {
            match from_server.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let channel = SendChannel(channel);
    let _ = std::thread::Builder::new()
        .name("voynix-bt-channel".into())
        .spawn(move || pump(channel, in_tx, out_rx));
}

/// Moves bytes between the channel's NSStreams and the tokio side until
/// either end closes. The streams are scheduled on this thread's run loop,
/// which is turned in short slices; between slices the streams are polled.
fn pump(channel: SendChannel, in_tx: mpsc::UnboundedSender<Vec<u8>>, mut out_rx: mpsc::Receiver<Vec<u8>>) {
    let channel = channel.0;
    let (Some(input), Some(output)) = (unsafe { channel.inputStream() }, unsafe { channel.outputStream() }) else { return };
    let run_loop = NSRunLoop::currentRunLoop();
    unsafe {
        input.scheduleInRunLoop_forMode(&run_loop, NSDefaultRunLoopMode);
        output.scheduleInRunLoop_forMode(&run_loop, NSDefaultRunLoopMode);
        input.open();
        output.open();
    }

    let mut buf = vec![0u8; CHUNK];
    let mut pending: Vec<u8> = Vec::new();
    let mut offset = 0usize;
    let mut server_done = false;
    'outer: loop {
        let slice = NSDate::dateWithTimeIntervalSinceNow(POLL_SLICE_SECS);
        // `false` = nothing to wait on (e.g. both streams already closed).
        let ran = unsafe { run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &slice) };
        if !ran {
            std::thread::sleep(Duration::from_millis(5));
        }

        // phone -> server
        while input.hasBytesAvailable() {
            let n = unsafe { input.read_maxLength(std::ptr::NonNull::new(buf.as_mut_ptr()).unwrap(), buf.len()) };
            if n <= 0 {
                break 'outer;
            }
            if in_tx.send(buf[..n as usize].to_vec()).is_err() {
                break 'outer;
            }
        }

        // server -> phone
        loop {
            if offset >= pending.len() {
                match out_rx.try_recv() {
                    Ok(chunk) => {
                        pending = chunk;
                        offset = 0;
                    }
                    Err(mpsc::error::TryRecvError::Empty) => break,
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        server_done = true;
                        break;
                    }
                }
            }
            if !output.hasSpaceAvailable() {
                break;
            }
            let rest = &pending[offset..];
            let n = unsafe { output.write_maxLength(std::ptr::NonNull::new(rest.as_ptr() as *mut u8).unwrap(), rest.len()) };
            if n <= 0 {
                break 'outer;
            }
            offset += n as usize;
        }

        if server_done && offset >= pending.len() {
            break;
        }
        let closed = |s: NSStreamStatus| s == NSStreamStatus::Closed || s == NSStreamStatus::Error;
        if closed(input.streamStatus()) || closed(output.streamStatus()) {
            break;
        }
    }

    unsafe {
        input.close();
        output.close();
        input.removeFromRunLoop_forMode(&run_loop, NSDefaultRunLoopMode);
        output.removeFromRunLoop_forMode(&run_loop, NSDefaultRunLoopMode);
    }
}

#[cfg(test)]
mod tests {
    use super::fingerprint_prefix;

    #[test]
    fn fingerprint_prefix_is_the_first_eight_bytes() {
        let fp = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert_eq!(fingerprint_prefix(fp), vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    }

    #[test]
    fn fingerprint_prefix_is_empty_for_junk() {
        assert!(fingerprint_prefix("").is_empty());
        assert!(fingerprint_prefix("zz112233445566778899").is_empty());
    }
}
