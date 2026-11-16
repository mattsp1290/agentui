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
