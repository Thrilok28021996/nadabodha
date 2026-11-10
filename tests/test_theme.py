from svara.ui import theme


def test_mocha_stylesheet_uses_catppuccin_colors():
    sheet = theme.stylesheet("mocha")
    assert "#1e1e2e" in sheet  # base
    assert "#cba6f7" in sheet  # mauve
    assert "#cdd6f4" in sheet  # text


def test_latte_stylesheet_uses_light_palette():
    sheet = theme.stylesheet("latte")
    assert "#eff1f5" in sheet  # base
    assert "#8839ef" in sheet  # mauve


def test_unknown_flavor_falls_back_to_mocha():
    assert theme.palette("mars") == theme.palette("mocha")
    assert theme.stylesheet("mars") == theme.stylesheet("mocha")


def test_every_palette_has_the_same_keys():
    keys = set(theme.PALETTES["mocha"])
    for flavor, palette in theme.PALETTES.items():
        assert set(palette) == keys, flavor
