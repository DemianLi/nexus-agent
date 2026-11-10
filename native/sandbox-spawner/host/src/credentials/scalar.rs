//! 純量讀成什麼：YAML 1.2 core schema，逐條照 TS 用的 `yaml`（eemeli）2.9.1 `schema/core`，判斷的順序也照它的表：
//! null、bool、八進位、十進位、十六進位、`.inf`／`.nan`、指數、小數，都不是就是字串。只有 plain 純量要判；加引號與區塊值一律是字串。
//!
//! 鍵轉成名字照 JS 的 `String(值)`（`addPairToJSMap` 的 `stringifyKey`）：null 是空字串，數字照 `Number.prototype.toString`。

/// 一個純量解出來的值。
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
}

impl Scalar {
    /// plain 純量的原文照 core schema 解。
    pub fn plain(text: &str) -> Scalar {
        if matches!(text, "" | "~" | "null" | "Null" | "NULL") {
            return Scalar::Null;
        }
        match text {
            "true" | "True" | "TRUE" => return Scalar::Bool(true),
            "false" | "False" | "FALSE" => return Scalar::Bool(false),
            _ => {}
        }
        if let Some(digits) = text.strip_prefix("0o") {
            if !digits.is_empty() && digits.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
                return Scalar::Number(power_of_two_radix(digits, 3));
            }
        }
        if is_decimal_int(text) {
            return Scalar::Number(parse_f64(text));
        }
        if let Some(digits) = text.strip_prefix("0x") {
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Scalar::Number(power_of_two_radix(digits, 4));
            }
        }
        match text {
            ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => return Scalar::Number(f64::INFINITY),
            "-.inf" | "-.Inf" | "-.INF" => return Scalar::Number(f64::NEG_INFINITY),
            ".nan" | ".NaN" | ".NAN" => return Scalar::Number(f64::NAN),
            _ => {}
        }
        if is_exp_float(text) || is_float(text) {
            return Scalar::Number(parse_f64(text));
        }
        Scalar::Str(text.to_string())
    }

    /// 當 mapping 的鍵時，轉成 JS 物件鍵的那個字串。
    pub fn key_name(&self) -> String {
        match self {
            Scalar::Null => String::new(),
            Scalar::Bool(b) => b.to_string(),
            Scalar::Number(n) => js_number_to_string(*n),
            Scalar::Str(s) => s.clone(),
        }
    }

}

/// `^[-+]?[0-9]+$`
fn is_decimal_int(text: &str) -> bool {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`
fn is_exp_float(text: &str) -> bool {
    let Some(at) = text.find(['e', 'E']) else {
        return false;
    };
    let (mantissa, exponent) = (&text[..at], &text[at + 1..]);
    let mantissa = mantissa.strip_prefix(['-', '+']).unwrap_or(mantissa);
    let exponent = exponent.strip_prefix(['-', '+']).unwrap_or(exponent);
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", fraction)) => all_digits(fraction),
        Some((whole, fraction)) => all_digits(whole) && fraction.bytes().all(|b| b.is_ascii_digit()),
        None => all_digits(mantissa),
    };
    mantissa_ok && all_digits(exponent)
}

/// `^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`
fn is_float(text: &str) -> bool {
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    match body.split_once('.') {
        Some(("", fraction)) => all_digits(fraction),
        Some((whole, fraction)) => all_digits(whole) && fraction.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// 十進位與小數照 `parseFloat`／`parseInt(…, 10)`：最接近的 f64。進到這裡的字串都已經過上面的形狀檢查。
fn parse_f64(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// `parseInt(…, 8)`、`parseInt(…, 16)`：基數是 2 的次方時 V8 照位元正確捨入（就近、平手取偶），超出就是 `Infinity`。
fn power_of_two_radix(digits: &str, bits_per_digit: u32) -> f64 {
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit as usize);
    for c in digits.chars() {
        let d = c.to_digit(1 << bits_per_digit).unwrap_or(0);
        for i in (0..bits_per_digit).rev() {
            bits.push(d >> i & 1 == 1);
        }
    }
    let first = bits.iter().position(|b| *b);
    let Some(first) = first else {
        return 0.0;
    };
    let bits = &bits[first..];
    if bits.len() <= 53 {
        return bits.iter().fold(0.0, |acc, b| acc * 2.0 + f64::from(u8::from(*b)));
    }
    let mut mantissa: u64 = bits[..53].iter().fold(0, |acc, b| acc << 1 | u64::from(*b));
    let half = bits[53];
    let sticky = bits[54..].iter().any(|b| *b);
    if half && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = bits.len() - 53;
    if exponent > 1100 {
        return f64::INFINITY;
    }
    mantissa as f64 * 2f64.powi(exponent as i32)
}

/// `Number.prototype.toString()`（ECMA-262 的 Number::toString，基數 10）。
pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // `{:e}` 給最短、能來回的有效數字：`d.ddde±x`。
    let formatted = format!("{:e}", n.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    // `n_exp` 是小數點的位置（ECMA-262 Number::toString 的 n）：值 = 0.digits × 10^n。
    let n_exp = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n_exp && n_exp <= 21 {
        format!("{digits}{}", "0".repeat((n_exp - k) as usize))
    } else if 0 < n_exp && n_exp <= 21 {
        let (whole, fraction) = digits.split_at(n_exp as usize);
        format!("{whole}.{fraction}")
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
    } else {
        let e = n_exp - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{e_sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{e_sign}{}", e.abs())
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 數字照_js_的_to_string() {
        for (n, s) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.5, "0.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (-2.5, "-2.5"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(js_number_to_string(n), s, "{n}");
        }
    }

    #[test]
    fn core_schema_的判斷順序() {
        assert_eq!(Scalar::plain("0o17"), Scalar::Number(15.0));
        assert_eq!(Scalar::plain("0x1F"), Scalar::Number(31.0));
        assert_eq!(Scalar::plain("012"), Scalar::Number(12.0));
        assert_eq!(Scalar::plain("+1"), Scalar::Number(1.0));
        assert_eq!(Scalar::plain("1."), Scalar::Number(1.0));
        assert_eq!(Scalar::plain(".5"), Scalar::Number(0.5));
        assert_eq!(Scalar::plain("1e3"), Scalar::Number(1000.0));
        assert_eq!(Scalar::plain(".1e1"), Scalar::Number(1.0));
        assert_eq!(Scalar::plain("-0x1"), Scalar::Str("-0x1".into()));
        assert_eq!(Scalar::plain("0b101"), Scalar::Str("0b101".into()));
        assert_eq!(Scalar::plain("+0x1"), Scalar::Str("+0x1".into()));
        assert_eq!(Scalar::plain("yes"), Scalar::Str("yes".into()));
        assert_eq!(Scalar::plain("tRUE"), Scalar::Str("tRUE".into()));
        assert_eq!(Scalar::plain("1_000"), Scalar::Str("1_000".into()));
        assert_eq!(Scalar::plain("1e"), Scalar::Str("1e".into()));
        assert_eq!(Scalar::plain("."), Scalar::Str(".".into()));
        assert_eq!(Scalar::plain("-.INF"), Scalar::Number(f64::NEG_INFINITY));
        assert_eq!(Scalar::plain("+.nan"), Scalar::Str("+.nan".into()));
        assert_eq!(Scalar::plain("NULL"), Scalar::Null);
        assert_eq!(Scalar::plain("nULL"), Scalar::Str("nULL".into()));
    }

    #[test]
    fn 二的次方基數照位元捨入() {
        assert_eq!(Scalar::plain("0x20000000000001").key_name(), "9007199254740992");
        assert_eq!(Scalar::plain("0x20000000000003").key_name(), "9007199254740996");
        assert_eq!(Scalar::plain(&format!("0x{}", "f".repeat(300))).key_name(), "Infinity");
    }
}
