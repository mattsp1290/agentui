use security_framework::os::macos::keychain::SecKeychain;
use std::sync::Mutex;

// The interaction flag is process-wide, and the suppression guard always re-enables it.
pub(crate) static INTERACTION: Mutex<()> = Mutex::new(());

pub enum ReadMode {
    Quiet,
    UserInitiated,
}

pub struct Keychain {
    pub handle: SecKeychain,
    pub service: String,
}
fn failure(error: security_framework::base::Error) -> &'static str {
    match error.code() {
        -25308 => "keychain-locked",
        -25293 | -128 | -25294 => "keychain-denied",
        _ => "keychain-unavailable",
    }
}
impl Keychain {
    pub fn read(&self, mode: ReadMode) -> Result<Option<Vec<u8>>, &'static str> {
        let _lock = INTERACTION.lock().map_err(|_| "keychain-unavailable")?;
        let _interaction = match mode {
            ReadMode::Quiet => Some(SecKeychain::disable_user_interaction().map_err(failure)?),
            ReadMode::UserInitiated => None,
        };
        match self
            .handle
            .find_generic_password(&self.service, "mac-default")
        {
            Ok((bytes, _)) => Ok(Some(bytes.to_vec())),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(failure(error)),
        }
    }
    pub fn write(
        &self,
        expected: &Option<Vec<u8>>,
        intended: &Option<Vec<u8>>,
    ) -> Result<(), &'static str> {
        let _lock = INTERACTION.lock().map_err(|_| "keychain-unavailable")?;
        let _interaction = SecKeychain::disable_user_interaction().map_err(failure)?;
        match self
            .handle
            .find_generic_password(&self.service, "mac-default")
        {
            Ok((bytes, mut item)) if expected.as_deref() == Some(bytes.as_ref()) => {
                if let Some(bytes) = intended {
                    item.set_password(bytes).map_err(failure)?;
                } else {
                    item.delete();
                }
            }
            Err(error) if error.code() == -25300 && expected.is_none() => {
                if let Some(bytes) = intended {
                    self.handle
                        .add_generic_password(&self.service, "mac-default", bytes)
                        .map_err(failure)?;
                }
            }
            Err(error) if error.code() != -25300 => return Err(failure(error)),
            _ => return Err("stale"),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::CreateOptions;
    use std::time::Duration;
    use uuid::Uuid;
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainDelete(keychain: *mut std::ffi::c_void) -> i32;
    }

    #[test]
    fn all_keychain_operations_wait_for_the_process_interaction_lock() {
        let directory =
            std::env::temp_dir().join(format!("agentui-keychain-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let handle = CreateOptions::new()
            .password(&Uuid::new_v4().to_string())
            .create(directory.join("test.keychain"))
            .unwrap();
        let service = format!("agentui-test-{}", Uuid::new_v4());
        let bytes = Some(b"value".to_vec());
        Keychain {
            handle: handle.clone(),
            service: service.clone(),
        }
        .write(&None, &bytes)
        .unwrap();
        for operation in ["quiet", "restore", "write"] {
            let store = Keychain {
                handle: handle.clone(),
                service: service.clone(),
            };
            let bytes = bytes.clone();
            let lock = INTERACTION.lock().unwrap();
            let interaction = SecKeychain::disable_user_interaction().unwrap();
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            let (started, starting) = std::sync::mpsc::channel();
            let (finished, finishing) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                started.send(()).unwrap();
                let result = match operation {
                    "quiet" => store
                        .read(ReadMode::Quiet)
                        .map(|actual| assert_eq!(actual, bytes)),
                    "restore" => store
                        .read(ReadMode::UserInitiated)
                        .map(|actual| assert_eq!(actual, bytes)),
                    _ => store.write(&bytes, &bytes),
                };
                finished.send(result).unwrap();
            });
            starting.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(
                finishing.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            drop(interaction);
            assert!(SecKeychain::user_interaction_allowed().unwrap());
            drop(lock);
            finishing
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            worker.join().unwrap();
            let _lock = INTERACTION.lock().unwrap();
            assert!(SecKeychain::user_interaction_allowed().unwrap());
        }
        unsafe {
            assert_eq!(SecKeychainDelete(handle.as_CFTypeRef() as *mut _), 0);
        }
        let _ = std::fs::remove_dir_all(&directory);
    }
}
