import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { AuthService } from "../../../core/auth.service";
import LoginPage from "./login";

describe("LoginPage", () => {
  let component: LoginPage;
  let fixture: ComponentFixture<LoginPage>;

  const authMock = {
    login: jasmine.createSpy("login").and.resolveTo({}),
    isAdmin: jasmine.createSpy("isAdmin").and.resolveTo(true),
    logout: jasmine.createSpy("logout").and.resolveTo(undefined),
  };

  const routerMock = {
    navigateByUrl: jasmine.createSpy("navigateByUrl").and.resolveTo(true),
  };

  const routeMock = {
    snapshot: { queryParams: {} as Record<string, string> },
  };

  beforeEach(async () => {
    localStorage.clear();
    authMock.login.calls.reset();
    authMock.isAdmin.calls.reset();
    authMock.logout.calls.reset();
    routerMock.navigateByUrl.calls.reset();

    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: Router, useValue: routerMock },
        { provide: ActivatedRoute, useValue: routeMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("should restore remembered email", () => {
    localStorage.setItem("bm_login_remember_email", "1");
    localStorage.setItem("bm_login_saved_email", "admin@basemayorista.com");

    const secondFixture = TestBed.createComponent(LoginPage);
    const secondComponent = secondFixture.componentInstance;
    secondFixture.detectChanges();

    expect(secondComponent.rememberEmail).toBeTrue();
    expect(secondComponent.email).toBe("admin@basemayorista.com");
  });

  it("should toggle password visibility", () => {
    expect(component.showPassword).toBeFalse();
    component.togglePasswordVisibility();
    expect(component.showPassword).toBeTrue();
  });

  it("should not submit when email is invalid", async () => {
    component.email = "correo-invalido";
    component.password = "123456";

    await component.onLogin();

    expect(component.hasEmailError()).toBeTrue();
    expect(authMock.login).not.toHaveBeenCalled();
  });

  it("should show email validation after touch", () => {
    component.email = "";
    component.markEmailTouched();

    expect(component.hasEmailError()).toBeTrue();
    expect(component.getEmailError()).toBe("El correo es obligatorio.");
  });

  it("should mark email as valid after touch with correct format", () => {
    component.email = "admin@basemayorista.com";
    component.markEmailTouched();

    expect(component.hasEmailValid()).toBeTrue();
    expect(component.hasEmailError()).toBeFalse();
  });
});
